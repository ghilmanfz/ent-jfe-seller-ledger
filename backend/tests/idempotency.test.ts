import { prisma } from '../src/lib/prisma';
import { IdempotencyConflictError, InvalidTransitionError } from '../src/lib/errors';
import * as financial from '../src/services/financial-service';
import { createOrder, createPaidOrder, key, money } from './helpers';

describe('idempotency', () => {
  it('same idempotencyKey on recordOrder returns the same order and writes nothing twice', async () => {
    const idempotencyKey = key();
    const args = {
      customerId: 'cus_idem',
      paymentMethod: 'card' as const,
      amount: money('10.00'),
      idempotencyKey,
    };

    const first = await financial.recordOrder(args);
    const second = await financial.recordOrder(args);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.event.id).toBe(first.event.id);
    expect(await prisma.eventLog.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);
    expect(await prisma.orderProjection.count()).toBe(1);
  });

  it('5 concurrent recordOrder calls with one key collapse into exactly one order', async () => {
    const idempotencyKey = key();
    const args = {
      customerId: 'cus_race',
      paymentMethod: 'card' as const,
      amount: money('42.42'),
      idempotencyKey,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => financial.recordOrder(args)),
    );

    const orderIds = new Set(results.map((result) => result.order.id));
    expect(orderIds.size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await prisma.eventLog.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);
  });

  it('reusing a key with a different amount is rejected with IDEMPOTENCY_CONFLICT', async () => {
    const idempotencyKey = key();
    await financial.recordOrder({
      customerId: 'cus_conflict',
      paymentMethod: 'card',
      amount: money('10.00'),
      idempotencyKey,
    });

    const attempt = financial.recordOrder({
      customerId: 'cus_conflict',
      paymentMethod: 'card',
      amount: money('999.00'), // same key, different money — must NOT replay silently
      idempotencyKey,
    });
    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(attempt).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('retrying the whole payment saga with the same key returns the same charge, no extra postings', async () => {
    const created = await createOrder({ amount: '25.00' });
    const payKey = key('pay');

    const first = await financial.processOrderPayment({
      orderId: created.order.id,
      idempotencyKey: payKey,
    });
    const second = await financial.processOrderPayment({
      orderId: created.order.id,
      idempotencyKey: payKey,
    });

    expect(second.charge.chargeId).toBe(first.charge.chargeId);
    expect(second.replayed).toBe(true);

    const events = await prisma.eventLog.findMany({ where: { aggregateId: created.order.id } });
    expect(events).toHaveLength(4); // created, processing, confirmed, fee — exactly once each
    expect(await prisma.ledgerEntry.count({ where: { orderId: created.order.id } })).toBe(6);
  });

  it('a NEW key on an already-paid order is blocked by the state machine', async () => {
    const { order } = await createPaidOrder('30.00');
    const attempt = financial.processOrderPayment({ orderId: order.id, idempotencyKey: key() });
    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);

    // Still exactly one payment in the ledger.
    const paymentRows = await prisma.ledgerEntry.count({
      where: { orderId: order.id, account: 'payment_received', debit: { not: null } },
    });
    expect(paymentRows).toBe(1);
  });
});
