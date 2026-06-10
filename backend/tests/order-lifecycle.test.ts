import { prisma } from '../src/lib/prisma';
import { toMoneyString } from '../src/lib/money';
import * as financial from '../src/services/financial-service';
import { createPaidOrder, key, money } from './helpers';

describe('order lifecycle (happy path)', () => {
  it('walks created -> paid -> fees -> shipped -> delivered with exact money and dense versions', async () => {
    const created = await financial.recordOrder({
      orderId: 'ord_happy_path',
      customerId: 'cus_alice',
      paymentMethod: 'card',
      amount: money('100.00'),
      idempotencyKey: key(),
    });
    expect(created.order.status).toBe('CREATED');
    expect(toMoneyString(created.order.amount)).toBe('100.0000');

    const paid = await financial.processOrderPayment({
      orderId: 'ord_happy_path',
      idempotencyKey: key('pay'),
    });
    expect(paid.order.status).toBe('PAID');
    expect(paid.charge.chargeId).toMatch(/^ch_[0-9a-f]{24}$/);
    expect(paid.order.feeAmount && toMoneyString(paid.order.feeAmount)).toBe('3.0000');
    expect(paid.order.payoutAmount && toMoneyString(paid.order.payoutAmount)).toBe('97.0000');
    expect(paid.order.stripeChargeId).toBe(paid.charge.chargeId);
    expect(paid.order.paidAt).toBeInstanceOf(Date);

    await financial.shipOrder({ orderId: 'ord_happy_path', idempotencyKey: key() });
    const delivered = await financial.deliverOrder({
      orderId: 'ord_happy_path',
      idempotencyKey: key(),
    });
    expect(delivered.order.status).toBe('DELIVERED');

    const events = await prisma.eventLog.findMany({
      where: { aggregateId: 'ord_happy_path' },
      orderBy: { version: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      'OrderCreated',
      'PaymentProcessing',
      'PaymentConfirmed',
      'FeeCalculated',
      'OrderShipped',
      'OrderDelivered',
    ]);
    expect(events.map((event) => event.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(delivered.order.version).toBe(6);

    // Money inside payloads travels as strings, never JSON numbers.
    const createdPayload = events[0]?.payload as { amount?: unknown };
    expect(typeof createdPayload.amount).toBe('string');
    expect(createdPayload.amount).toBe('100.0000');

    const verification = await financial.verifyLedgerBalance('ord_happy_path');
    expect(verification.balanced).toBe(true);
    expect(verification.entryCount).toBe(6); // create pair + payment pair + fee pair
    expect(verification.sumDebits).toBe('203.0000');
    expect(verification.sumCredits).toBe('203.0000');
  });

  it('refund reverses everything: order REFUNDED and every account nets to zero', async () => {
    const { order } = await createPaidOrder('50.00');

    const refunded = await financial.refundOrder({
      orderId: order.id,
      idempotencyKey: key(),
      reason: 'customer changed their mind',
    });
    expect(refunded.order.status).toBe('REFUNDED');

    const verification = await financial.verifyLedgerBalance(order.id);
    expect(verification.balanced).toBe(true);
    for (const account of verification.accounts) {
      expect(account.net).toBe('0.0000');
    }
    // create(2) + payment(2) + fee(2) + refund reversal(6)
    expect(verification.entryCount).toBe(12);
  });
});
