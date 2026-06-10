import { randomUUID } from 'node:crypto';
import { OrderProjection } from '@prisma/client';
import { Decimal, Money } from '../src/lib/money';
import * as financial from '../src/services/financial-service';

export function key(label = 'key'): string {
  return `${label}:${randomUUID()}`;
}

export function money(value: string): Money {
  return new Decimal(value);
}

export interface CreateOrderOverrides {
  orderId?: string;
  customerId?: string;
  paymentMethod?: 'card' | 'bank_transfer' | 'wallet';
  amount?: string;
  idempotencyKey?: string;
}

export async function createOrder(
  overrides: CreateOrderOverrides = {},
): Promise<financial.MutationResult> {
  return financial.recordOrder({
    orderId: overrides.orderId,
    customerId: overrides.customerId ?? 'cus_test',
    paymentMethod: overrides.paymentMethod ?? 'card',
    amount: money(overrides.amount ?? '100.00'),
    idempotencyKey: overrides.idempotencyKey ?? key('create'),
  });
}

/** Create + run the full payment saga. Returns the paid order projection. */
export async function createPaidOrder(
  amount = '100.00',
  overrides: CreateOrderOverrides = {},
): Promise<{ order: OrderProjection; payKey: string }> {
  const created = await createOrder({ ...overrides, amount });
  const payKey = key('pay');
  const paid = await financial.processOrderPayment({
    orderId: created.order.id,
    idempotencyKey: payKey,
  });
  return { order: paid.order, payKey };
}
