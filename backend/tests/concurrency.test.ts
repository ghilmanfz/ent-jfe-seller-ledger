import { prisma } from '../src/lib/prisma';
import { AppError, VersionConflictError } from '../src/lib/errors';
import { appendEvent } from '../src/services/event-store';
import * as financial from '../src/services/financial-service';
import { createOrder, key } from './helpers';

function rejectionsOf(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('concurrency safety', () => {
  it('two concurrent recordPayment writers on one order: exactly one succeeds, the other gets VersionConflict', async () => {
    const created = await createOrder({ orderId: 'ord_pay_race', amount: '60.00' });
    const order = created.order;

    // Writer A appends PaymentConfirmed v2 but HOLDS its transaction open, so
    // the interleaving is pinned: B must make every decision while A is still
    // uncommitted. This is the worst-case schedule of two simultaneous
    // recordPayment calls, reproduced deterministically.
    let commitA!: () => void;
    const holdA = new Promise<void>((resolve) => {
      commitA = resolve;
    });
    let signalInserted!: () => void;
    const aInserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const writerA = prisma.$transaction(async (tx) => {
      await appendEvent(tx, {
        aggregateId: order.id,
        eventType: 'PaymentConfirmed',
        payload: { orderId: order.id, amount: '60.0000', stripeChargeId: 'ch_winner' },
        version: 2,
        idempotencyKey: key('winner'),
      });
      signalInserted();
      await holdA;
    });
    await aInserted; // A's v2 INSERT is in flight, not yet committed

    // Writer B: a real recordPayment. It reads the latest *committed* version
    // (1), computes the same next version (2), and its INSERT parks on the
    // unique (aggregateId, version) index that A is holding.
    const writerB = financial.recordPayment({
      orderId: order.id,
      amount: order.amount,
      stripeChargeId: 'ch_loser',
      idempotencyKey: key('loser'),
    });
    writerB.catch(() => undefined); // assertions attach below; avoid unhandled-rejection noise

    await sleep(150); // let B reach the index wait
    commitA(); // A commits -> B's INSERT must now fail
    await writerA;

    await expect(writerB).rejects.toBeInstanceOf(VersionConflictError);
    await expect(writerB).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    // Exactly one PaymentConfirmed (writer A's) exists; B wrote nothing.
    expect(
      await prisma.eventLog.count({
        where: { aggregateId: order.id, eventType: 'PaymentConfirmed' },
      }),
    ).toBe(1);
    expect(
      await prisma.ledgerEntry.count({
        where: { orderId: order.id, account: 'payment_received' },
      }),
    ).toBe(0);
  });

  it('two concurrent full payment sagas with distinct keys: one wins, money moves once', async () => {
    const created = await createOrder({ orderId: 'ord_saga_race', amount: '75.00' });

    const results = await Promise.allSettled([
      financial.processOrderPayment({ orderId: created.order.id, idempotencyKey: key('saga1') }),
      financial.processOrderPayment({ orderId: created.order.id, idempotencyKey: key('saga2') }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejections = rejectionsOf(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    // Depending on where the loser loses the race, it sees a version conflict
    // (simultaneous append) or an invalid transition (winner already moved on).
    // Both are correct double-payment rejections.
    const rejection = rejections[0] as AppError;
    expect(['VERSION_CONFLICT', 'INVALID_TRANSITION']).toContain(rejection.code);

    expect(
      await prisma.eventLog.count({
        where: { aggregateId: created.order.id, eventType: 'PaymentConfirmed' },
      }),
    ).toBe(1);
    expect(
      await prisma.eventLog.count({
        where: { aggregateId: created.order.id, eventType: 'FeeCalculated' },
      }),
    ).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { orderId: created.order.id } })).toBe(6);

    const order = await prisma.orderProjection.findUniqueOrThrow({
      where: { id: created.order.id },
    });
    expect(order.status).toBe('PAID');
  });

  it('two concurrent creates of the same orderId with different keys: exactly one order exists', async () => {
    const results = await Promise.allSettled([
      createOrder({ orderId: 'ord_create_race', idempotencyKey: key('c1') }),
      createOrder({ orderId: 'ord_create_race', idempotencyKey: key('c2') }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejections = rejectionsOf(results);
    expect(fulfilled).toHaveLength(1);
    expect(rejections).toHaveLength(1);
    const rejection = rejections[0] as AppError;
    expect(['VERSION_CONFLICT', 'INVALID_TRANSITION']).toContain(rejection.code);

    expect(await prisma.eventLog.count({ where: { aggregateId: 'ord_create_race' } })).toBe(1);
    expect(await prisma.orderProjection.count({ where: { id: 'ord_create_race' } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { orderId: 'ord_create_race' } })).toBe(2);
  });
});
