import { prisma } from '../src/lib/prisma';
import { toMoneyString } from '../src/lib/money';
import { todayUtc } from '../src/lib/ids';
import * as financial from '../src/services/financial-service';
import { rebuildOrderStates } from '../src/services/projector';
import { createOrder, createPaidOrder, key } from './helpers';

describe('projection consistency (read model = fold(event log))', () => {
  it('rebuilding every order from the raw event stream reproduces the stored projections exactly', async () => {
    // A deliberately messy day: every lifecycle path, plus a settlement.
    await createOrder({ orderId: 'ord_pc_created', amount: '75.25' });

    await createPaidOrder('100.00', { orderId: 'ord_pc_paid' });

    await createPaidOrder('19.99', { orderId: 'ord_pc_shipped' });
    await financial.shipOrder({ orderId: 'ord_pc_shipped', idempotencyKey: key() });

    await createPaidOrder('999999.99', { orderId: 'ord_pc_delivered' });
    await financial.shipOrder({ orderId: 'ord_pc_delivered', idempotencyKey: key() });
    await financial.deliverOrder({ orderId: 'ord_pc_delivered', idempotencyKey: key() });

    await createPaidOrder('49.90', { orderId: 'ord_pc_refunded' });
    await financial.refundOrder({
      orderId: 'ord_pc_refunded',
      idempotencyKey: key(),
      reason: 'damaged in transit',
    });

    await createOrder({ orderId: 'ord_pc_declined', customerId: 'cus_pc_declined' });
    await financial
      .processOrderPayment({ orderId: 'ord_pc_declined', idempotencyKey: key() })
      .catch(() => undefined); // expected decline

    await financial.dailySettlement({ date: todayUtc() }); // settles the three paid-ish orders

    // ---- Replay from scratch and diff against the live read model ----
    const events = await prisma.eventLog.findMany({
      orderBy: [{ timestamp: 'asc' }, { version: 'asc' }],
    });
    const rebuilt = rebuildOrderStates(events);
    const stored = await prisma.orderProjection.findMany();

    expect(rebuilt.size).toBe(stored.length);
    for (const row of stored) {
      const state = rebuilt.get(row.id);
      expect(state).toBeDefined();
      if (!state) continue;

      expect(state.status).toBe(row.status);
      expect(state.version).toBe(row.version);
      expect(state.customerId).toBe(row.customerId);
      expect(state.paymentMethod).toBe(row.paymentMethod);
      expect(toMoneyString(state.amount)).toBe(toMoneyString(row.amount));
      expect(state.feeAmount ? toMoneyString(state.feeAmount) : null).toBe(
        row.feeAmount ? toMoneyString(row.feeAmount) : null,
      );
      expect(state.payoutAmount ? toMoneyString(state.payoutAmount) : null).toBe(
        row.payoutAmount ? toMoneyString(row.payoutAmount) : null,
      );
      expect(state.stripeChargeId).toBe(row.stripeChargeId);
      expect(state.settlementId).toBe(row.settlementId);
      expect(state.settledAt?.toISOString() ?? null).toBe(row.settledAt?.toISOString() ?? null);
      expect(state.paidAt?.toISOString() ?? null).toBe(row.paidAt?.toISOString() ?? null);
      expect(state.createdAt.toISOString()).toBe(row.createdAt.toISOString());
    }
  });
});
