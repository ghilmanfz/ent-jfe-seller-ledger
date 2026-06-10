import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { toMoneyString, ZERO } from '../src/lib/money';
import * as financial from '../src/services/financial-service';
import { money } from './helpers';

const AMOUNTS = ['10.00', '19.99', '0.07', '999999.99', '1.00', '123.4567'];

describe('100 concurrent orders (Task A.5)', () => {
  it('creates and pays 100 orders concurrently: all recorded once, no duplicates, books balanced', async () => {
    // ---- Phase 1: 100 creates + 10 duplicate-key calls fired concurrently ----
    const createArgs = Array.from({ length: 100 }, (_, i) => ({
      orderId: `ord_bulk_${String(i).padStart(3, '0')}`,
      customerId: `cus_bulk_${i % 7}`,
      paymentMethod: 'card' as const,
      amount: money(AMOUNTS[i % AMOUNTS.length] ?? '10.00'),
      idempotencyKey: `bulk:create:${i}`,
    }));
    const duplicates = createArgs.filter((_, i) => i % 10 === 0); // same keys, fired again

    const createResults = await Promise.all(
      [...createArgs, ...duplicates].map((args) => financial.recordOrder(args)),
    );
    expect(createResults).toHaveLength(110);

    // All recorded exactly once, duplicates collapsed by idempotency.
    expect(await prisma.eventLog.count({ where: { eventType: 'OrderCreated' } })).toBe(100);
    expect(await prisma.orderProjection.count()).toBe(100);
    expect(await prisma.ledgerEntry.count()).toBe(200);
    expect(createResults.filter((result) => result.replayed)).toHaveLength(10);

    // Expected gross = sum of all 100 amounts, computed in Decimal.
    const expectedGross = createArgs.reduce<Prisma.Decimal>(
      (sum, args) => sum.add(args.amount),
      ZERO,
    );
    let trial = await financial.trialBalance();
    expect(trial.balanced).toBe(true);
    expect(trial.sumDebits).toBe(toMoneyString(expectedGross));
    expect(trial.sumCredits).toBe(toMoneyString(expectedGross));

    // ---- Phase 2: pay all 100 concurrently (full saga each) ----
    const payResults = await Promise.all(
      createArgs.map((args, i) =>
        financial.processOrderPayment({
          orderId: args.orderId,
          idempotencyKey: `bulk:pay:${i}`,
        }),
      ),
    );
    expect(payResults.filter((result) => result.order.status === 'PAID')).toHaveLength(100);

    expect(await prisma.eventLog.count({ where: { eventType: 'PaymentConfirmed' } })).toBe(100);
    expect(await prisma.eventLog.count({ where: { eventType: 'FeeCalculated' } })).toBe(100);
    expect(await prisma.ledgerEntry.count()).toBe(600); // (2+2+2) × 100

    trial = await financial.trialBalance();
    expect(trial.balanced).toBe(true);

    // Every single order individually balanced, in one grouped query.
    const perOrder = await prisma.ledgerEntry.groupBy({
      by: ['orderId'],
      _sum: { debit: true, credit: true },
    });
    expect(perOrder).toHaveLength(100);
    for (const group of perOrder) {
      const debits = group._sum.debit ?? ZERO;
      const credits = group._sum.credit ?? ZERO;
      expect(toMoneyString(debits)).toBe(toMoneyString(credits));
    }

    // ---- Phase 3: settle and check the payout equals Σ(amount − fee) ----
    const expectedPayout = payResults.reduce<Prisma.Decimal>(
      (sum, result) => sum.add(result.order.payoutAmount ?? ZERO),
      ZERO,
    );
    const settlement = await financial.dailySettlement({
      date: new Date().toISOString().slice(0, 10),
    });
    expect(settlement.orderCount).toBe(100);
    expect(settlement.totalPayout).toBe(toMoneyString(expectedPayout));

    trial = await financial.trialBalance();
    expect(trial.balanced).toBe(true);
  }, 120_000);
});
