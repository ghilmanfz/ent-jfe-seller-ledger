import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { toMoneyString } from '../src/lib/money';
import { OrderState, rebuildOrderStates } from '../src/services/projector';

/**
 * "Replay the day": rebuild every order projection purely from the event log
 * and reconcile it against the stored read model. With --write, drifted or
 * missing rows are repaired (events stay untouched — they are the truth).
 *
 * Usage:  npm run db:replay            # report drift only
 *         npm run db:replay -- --write # repair projections from events
 */

function describeDrift(stored: Record<string, unknown> | null, rebuilt: OrderState): string[] {
  if (!stored) return ['row missing'];
  const drifts: string[] = [];
  const compare: Array<[string, unknown, unknown]> = [
    ['status', stored['status'], rebuilt.status],
    ['version', stored['version'], rebuilt.version],
    ['amount', stored['amount'], toMoneyString(rebuilt.amount)],
    ['feeAmount', stored['feeAmount'], rebuilt.feeAmount ? toMoneyString(rebuilt.feeAmount) : null],
    ['payoutAmount', stored['payoutAmount'], rebuilt.payoutAmount ? toMoneyString(rebuilt.payoutAmount) : null],
    ['stripeChargeId', stored['stripeChargeId'], rebuilt.stripeChargeId],
    ['settlementId', stored['settlementId'], rebuilt.settlementId],
  ];
  for (const [field, storedValue, rebuiltValue] of compare) {
    if (storedValue !== rebuiltValue) {
      drifts.push(`${field}: stored=${String(storedValue)} rebuilt=${String(rebuiltValue)}`);
    }
  }
  return drifts;
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write');

  const events = await prisma.eventLog.findMany({
    orderBy: [{ timestamp: 'asc' }, { version: 'asc' }],
  });
  console.log(`Replaying ${events.length} events…`);
  const rebuilt = rebuildOrderStates(events);

  const stored = await prisma.orderProjection.findMany();
  const storedById = new Map(
    stored.map((row) => [
      row.id,
      {
        status: row.status as string,
        version: row.version,
        amount: toMoneyString(row.amount),
        feeAmount: row.feeAmount ? toMoneyString(row.feeAmount) : null,
        payoutAmount: row.payoutAmount ? toMoneyString(row.payoutAmount) : null,
        stripeChargeId: row.stripeChargeId,
        settlementId: row.settlementId,
      },
    ]),
  );

  let driftCount = 0;
  for (const [orderId, state] of rebuilt) {
    const drifts = describeDrift(storedById.get(orderId) ?? null, state);
    if (drifts.length > 0) {
      driftCount += 1;
      console.log(`DRIFT ${orderId}:`);
      for (const drift of drifts) console.log(`  - ${drift}`);
      if (write) {
        await prisma.orderProjection.upsert({
          where: { id: orderId },
          create: {
            id: state.id,
            customerId: state.customerId,
            paymentMethod: state.paymentMethod,
            amount: state.amount,
            feeAmount: state.feeAmount,
            payoutAmount: state.payoutAmount,
            status: state.status,
            version: state.version,
            stripeChargeId: state.stripeChargeId,
            settlementId: state.settlementId,
            settledAt: state.settledAt,
            paidAt: state.paidAt,
            createdAt: state.createdAt,
          },
          update: {
            status: state.status,
            version: state.version,
            feeAmount: state.feeAmount,
            payoutAmount: state.payoutAmount,
            stripeChargeId: state.stripeChargeId,
            settlementId: state.settlementId,
            settledAt: state.settledAt,
            paidAt: state.paidAt,
          },
        });
        console.log('  -> repaired from event stream');
      }
    }
  }

  console.log(
    `\n${rebuilt.size} orders rebuilt, ${driftCount} drifted${write ? ' (repaired)' : ''}.`,
  );
  if (driftCount > 0 && !write) {
    console.log('Run with --write to repair projections from the event log.');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
