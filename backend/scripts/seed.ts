import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { parseOrderAmount } from '../src/lib/money';
import * as financial from '../src/services/financial-service';

/**
 * Demo dataset for the dashboard. Everything goes through the real service
 * layer (never raw inserts), so seeded data obeys every invariant. Keys are
 * deterministic ("seed:*"): re-running the seed replays idempotently.
 */

async function reset(): Promise<void> {
  // TRUNCATE bypasses the append-only row triggers by design (dev/test only).
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ledger_entry", "event_log", "order_projection", "settlement" CASCADE',
  );
}

interface SeedOrder {
  id: string;
  customer: string;
  amount: string;
  method: 'card' | 'bank_transfer' | 'wallet';
  flow: 'created' | 'paid' | 'shipped' | 'delivered' | 'refunded' | 'declined';
}

const ORDERS: SeedOrder[] = [
  { id: 'ord_seed_delivered_01', customer: 'cus_alice', amount: '125.50', method: 'card', flow: 'delivered' },
  { id: 'ord_seed_shipped_01', customer: 'cus_bob', amount: '999.95', method: 'card', flow: 'shipped' },
  { id: 'ord_seed_paid_01', customer: 'cus_carol', amount: '19.99', method: 'wallet', flow: 'paid' },
  { id: 'ord_seed_paid_02', customer: 'cus_alice', amount: '10.00', method: 'bank_transfer', flow: 'paid' },
  { id: 'ord_seed_paid_03', customer: 'cus_dave', amount: '10.5555', method: 'card', flow: 'paid' },
  { id: 'ord_seed_refunded_01', customer: 'cus_bob', amount: '49.90', method: 'card', flow: 'refunded' },
  { id: 'ord_seed_created_01', customer: 'cus_carol', amount: '75.25', method: 'card', flow: 'created' },
  { id: 'ord_seed_declined_01', customer: 'cus_eve_declined', amount: '32.80', method: 'card', flow: 'declined' },
];

async function seedOrder(spec: SeedOrder): Promise<void> {
  await financial.recordOrder({
    orderId: spec.id,
    customerId: spec.customer,
    paymentMethod: spec.method,
    amount: parseOrderAmount(spec.amount),
    idempotencyKey: `seed:${spec.id}:create`,
  });
  if (spec.flow === 'created') return;

  try {
    await financial.processOrderPayment({ orderId: spec.id, idempotencyKey: `seed:${spec.id}:pay` });
  } catch (error) {
    if (spec.flow === 'declined') return; // expected for *_declined customers
    throw error;
  }

  if (spec.flow === 'shipped' || spec.flow === 'delivered') {
    await financial.shipOrder({ orderId: spec.id, idempotencyKey: `seed:${spec.id}:ship` });
  }
  if (spec.flow === 'delivered') {
    await financial.deliverOrder({ orderId: spec.id, idempotencyKey: `seed:${spec.id}:deliver` });
  }
  if (spec.flow === 'refunded') {
    await financial.refundOrder({
      orderId: spec.id,
      idempotencyKey: `seed:${spec.id}:refund`,
      reason: 'customer request (seed)',
    });
  }
}

async function main(): Promise<void> {
  const shouldReset = process.argv.includes('--reset');
  if (shouldReset) {
    console.log('Resetting database…');
    await reset();
  }

  for (const spec of ORDERS) {
    await seedOrder(spec);
    console.log(`seeded ${spec.id} (${spec.flow})`);
  }

  const balance = await financial.trialBalance();
  console.log('\nTrial balance:');
  console.log(`  entries     : ${balance.entryCount}`);
  console.log(`  sum debits  : ${balance.sumDebits}`);
  console.log(`  sum credits : ${balance.sumCredits}`);
  console.log(`  balanced    : ${balance.balanced ? 'YES' : 'NO — INVESTIGATE'}`);
  if (!balance.balanced) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
