import { prisma } from '../src/lib/prisma';
import {
  CardDeclinedError,
  InvalidTransitionError,
  NotFoundError,
  StripeApiError,
  ValidationError,
} from '../src/lib/errors';
import * as financial from '../src/services/financial-service';
import { createOrder, createPaidOrder, key, money } from './helpers';

describe('state machine discipline', () => {
  it('rejects operations on nonexistent orders', async () => {
    await expect(
      financial.processOrderPayment({ orderId: 'ord_ghost', idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(financial.verifyLedgerBalance('ord_ghost')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects out-of-order lifecycle transitions', async () => {
    const created = await createOrder();
    const orderId = created.order.id;

    // ship before pay
    await expect(
      financial.shipOrder({ orderId, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    // deliver before ship (and before pay)
    await expect(
      financial.deliverOrder({ orderId, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    // refund before any money moved
    await expect(
      financial.refundOrder({ orderId, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    // fees before payment
    await expect(
      financial.calculateFees({ orderId, amount: created.order.amount, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const { order } = await createPaidOrder('20.00');
    // deliver before ship (paid order)
    await expect(
      financial.deliverOrder({ orderId: order.id, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('prevents double payment: sequential second attempt with a fresh key gets INVALID_TRANSITION', async () => {
    const { order } = await createPaidOrder('15.00');
    const attempt = financial.processOrderPayment({ orderId: order.id, idempotencyKey: key() });
    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('prevents double fee calculation with a fresh key', async () => {
    const { order } = await createPaidOrder('15.00');
    const attempt = financial.calculateFees({
      orderId: order.id,
      amount: order.amount,
      idempotencyKey: key(),
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('rejects a payment whose amount does not match the order', async () => {
    const created = await createOrder({ amount: '80.00' });
    await expect(
      financial.recordPayment({
        orderId: created.order.id,
        amount: money('79.99'),
        stripeChargeId: 'ch_mismatch',
        idempotencyKey: key(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('card decline: PAYMENT_FAILED is recorded, no money moves, retry with a new key is allowed', async () => {
    const created = await createOrder({ customerId: 'cus_grace_declined', amount: '10.00' });
    const orderId = created.order.id;

    await expect(
      financial.processOrderPayment({ orderId, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(CardDeclinedError);

    let order = await prisma.orderProjection.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAYMENT_FAILED');
    // Only the order-creation pair exists — a failed charge moves no money.
    expect(await prisma.ledgerEntry.count({ where: { orderId } })).toBe(2);

    // A new attempt is allowed from PAYMENT_FAILED (still declines for this customer).
    await expect(
      financial.processOrderPayment({ orderId, idempotencyKey: key() }),
    ).rejects.toBeInstanceOf(CardDeclinedError);
    order = await prisma.orderProjection.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAYMENT_FAILED');

    const events = await prisma.eventLog.findMany({
      where: { aggregateId: orderId },
      orderBy: { version: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'OrderCreated',
      'PaymentProcessing',
      'PaymentFailed',
      'PaymentProcessing',
      'PaymentFailed',
    ]);
  });

  it('transient provider outage: state stays PAYMENT_PROCESSING and only the SAME key may resume', async () => {
    const created = await createOrder({ customerId: 'cus_flaky_unavailable', amount: '10.00' });
    const orderId = created.order.id;
    const payKey = key('stuck');

    await expect(
      financial.processOrderPayment({ orderId, idempotencyKey: payKey }),
    ).rejects.toBeInstanceOf(StripeApiError);
    const order = await prisma.orderProjection.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PAYMENT_PROCESSING');

    // A DIFFERENT key may not start a second live attempt (double-charge risk).
    await expect(
      financial.processOrderPayment({ orderId, idempotencyKey: key('fresh') }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    // The SAME key resumes (and hits the same simulated outage deterministically).
    await expect(
      financial.processOrderPayment({ orderId, idempotencyKey: payKey }),
    ).rejects.toBeInstanceOf(StripeApiError);
  });
});
