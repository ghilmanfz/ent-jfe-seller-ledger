import { prisma } from '../src/lib/prisma';
import { InvalidTransitionError } from '../src/lib/errors';
import { todayUtc } from '../src/lib/ids';
import * as financial from '../src/services/financial-service';
import { createOrder, createPaidOrder, key } from './helpers';

describe('daily settlement (Part C.3)', () => {
  it('settles exactly the eligible orders with payout = Σ(amount − fee)', async () => {
    await createPaidOrder('100.00'); // payout 97.0000
    await createPaidOrder('19.99'); // payout 19.3903
    await createPaidOrder('0.07'); // payout  0.0679
    await createOrder({ orderId: 'ord_unpaid', amount: '50.00' }); // not eligible
    const refunded = await createPaidOrder('25.00');
    await financial.refundOrder({ orderId: refunded.order.id, idempotencyKey: key() }); // not eligible

    const result = await financial.dailySettlement({ date: todayUtc(), idempotencyKey: key() });

    expect(result.alreadySettled).toBe(false);
    expect(result.orderCount).toBe(3);
    expect(result.totalGross).toBe('120.0600');
    expect(result.totalFees).toBe('3.6018');
    expect(result.totalPayout).toBe('116.4582'); // 97.0000 + 19.3903 + 0.0679

    const settled = await prisma.orderProjection.findMany({
      where: { settlementId: { not: null } },
    });
    expect(settled).toHaveLength(3);
    expect(settled.every((order) => order.settledAt !== null)).toBe(true);

    const unpaid = await prisma.orderProjection.findUniqueOrThrow({ where: { id: 'ord_unpaid' } });
    expect(unpaid.settlementId).toBeNull();
    const refundedRow = await prisma.orderProjection.findUniqueOrThrow({
      where: { id: refunded.order.id },
    });
    expect(refundedRow.settlementId).toBeNull();

    // One settlement event carrying the full per-order breakdown.
    const events = await prisma.eventLog.findMany({ where: { eventType: 'SettlementProcessed' } });
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { orderCount: number; orders: unknown[] };
    expect(payload.orderCount).toBe(3);
    expect(payload.orders).toHaveLength(3);

    const trial = await financial.trialBalance();
    expect(trial.balanced).toBe(true);
  });

  it('settling the same date twice returns the identical result — same key, different key, or no key', async () => {
    await createPaidOrder('100.00');
    const date = todayUtc();

    const first = await financial.dailySettlement({ date, idempotencyKey: 'settle:fixed:001' });
    const ledgerRowsAfterFirst = await prisma.ledgerEntry.count();

    const sameKey = await financial.dailySettlement({ date, idempotencyKey: 'settle:fixed:001' });
    const differentKey = await financial.dailySettlement({ date, idempotencyKey: key() });
    const noKey = await financial.dailySettlement({ date });

    for (const replay of [sameKey, differentKey, noKey]) {
      expect(replay.alreadySettled).toBe(true);
      expect(replay.settlementId).toBe(first.settlementId);
      expect(replay.totalPayout).toBe(first.totalPayout);
      expect(replay.orderCount).toBe(first.orderCount);
    }

    expect(await prisma.settlement.count()).toBe(1);
    expect(await prisma.eventLog.count({ where: { eventType: 'SettlementProcessed' } })).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerRowsAfterFirst); // no extra postings
  });

  it('two concurrent settlements of one date converge on a single result', async () => {
    await createPaidOrder('40.00');
    const date = todayUtc();

    const [a, b] = await Promise.all([
      financial.dailySettlement({ date, idempotencyKey: key('sa') }),
      financial.dailySettlement({ date, idempotencyKey: key('sb') }),
    ]);

    expect(a.settlementId).toBe(b.settlementId);
    expect(a.totalPayout).toBe(b.totalPayout);
    expect([a.alreadySettled, b.alreadySettled].filter(Boolean)).toHaveLength(1);
    expect(await prisma.settlement.count()).toBe(1);
    expect(await prisma.eventLog.count({ where: { eventType: 'SettlementProcessed' } })).toBe(1);
  });

  it('orders paid after the settled date are excluded; an empty settlement is still recorded', async () => {
    await createPaidOrder('10.00'); // paid today
    const past = await financial.dailySettlement({ date: '2020-01-01' });
    expect(past.orderCount).toBe(0);
    expect(past.totalPayout).toBe('0.0000');

    const today = await financial.dailySettlement({ date: todayUtc() });
    expect(today.orderCount).toBe(1); // picked up by today's run instead
  });

  it('refunds are rejected once an order is settled', async () => {
    const { order } = await createPaidOrder('30.00');
    await financial.dailySettlement({ date: todayUtc() });

    const attempt = financial.refundOrder({ orderId: order.id, idempotencyKey: key() });
    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(attempt).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});
