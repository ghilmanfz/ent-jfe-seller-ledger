import { EventLog, OrderStatus, PaymentMethod } from '@prisma/client';
import * as payloads from '../domain/events';
import { nextStatus, OrderEventType } from '../domain/state-machine';
import { Decimal, Money } from '../lib/money';

/**
 * Pure projection logic: fold events into the order read model.
 *
 * The SAME reducer drives both the live projection (updated in the event's own
 * transaction) and full rebuilds (scripts/rebuild-projections.ts), so the two
 * can never drift apart by construction. The projection-consistency test
 * rebuilds every order from the event stream and diffs it against the stored
 * read model.
 */

export interface OrderState {
  id: string;
  customerId: string;
  paymentMethod: PaymentMethod;
  amount: Money;
  feeAmount: Money | null;
  payoutAmount: Money | null;
  status: OrderStatus;
  version: number;
  stripeChargeId: string | null;
  settlementId: string | null;
  settledAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export type StoredEvent = Pick<
  EventLog,
  'id' | 'aggregateId' | 'eventType' | 'payload' | 'version' | 'timestamp'
>;

export function applyOrderEvent(state: OrderState | null, event: StoredEvent): OrderState {
  const eventType = event.eventType as OrderEventType;

  if (eventType === 'OrderCreated') {
    const payload = event.payload as unknown as payloads.OrderCreatedPayload;
    return {
      id: payload.orderId,
      customerId: payload.customerId,
      paymentMethod: payload.paymentMethod,
      amount: new Decimal(payload.amount),
      feeAmount: null,
      payoutAmount: null,
      status: nextStatus(eventType),
      version: event.version,
      stripeChargeId: null,
      settlementId: null,
      settledAt: null,
      paidAt: null,
      createdAt: event.timestamp,
    };
  }

  if (!state) {
    throw new Error(
      `Corrupt stream: ${event.eventType} for "${event.aggregateId}" has no preceding OrderCreated`,
    );
  }

  const next: OrderState = { ...state, status: nextStatus(eventType), version: event.version };

  switch (eventType) {
    case 'PaymentConfirmed': {
      const payload = event.payload as unknown as payloads.PaymentConfirmedPayload;
      next.stripeChargeId = payload.stripeChargeId;
      next.paidAt = event.timestamp;
      break;
    }
    case 'FeeCalculated': {
      const payload = event.payload as unknown as payloads.FeeCalculatedPayload;
      next.feeAmount = new Decimal(payload.feeAmount);
      next.payoutAmount = new Decimal(payload.payoutAmount);
      break;
    }
    case 'PaymentProcessing':
    case 'PaymentFailed':
    case 'OrderShipped':
    case 'OrderDelivered':
    case 'OrderRefunded':
      // Pure status transitions; nextStatus already applied.
      break;
  }
  return next;
}

/**
 * Settlement events live on their own aggregate and mark orders as settled
 * without bumping the order's version. They only ever SET settlementId and
 * settledAt — fields no order event touches — so the fold result is the same
 * regardless of how settlement interleaves with later fulfillment events.
 */
export function applySettlementToOrders(
  orders: Map<string, OrderState>,
  event: StoredEvent,
): void {
  const payload = event.payload as unknown as payloads.SettlementProcessedPayload;
  for (const line of payload.orders) {
    const state = orders.get(line.orderId);
    if (state) {
      state.settlementId = event.aggregateId;
      state.settledAt = event.timestamp;
    }
  }
}

/** Rebuild every order's state from a full, raw event stream. */
export function rebuildOrderStates(events: StoredEvent[]): Map<string, OrderState> {
  const orders = new Map<string, OrderState>();

  const orderEvents = events
    .filter((event) => event.eventType !== 'SettlementProcessed')
    .sort((a, b) => a.aggregateId.localeCompare(b.aggregateId) || a.version - b.version);
  for (const event of orderEvents) {
    orders.set(event.aggregateId, applyOrderEvent(orders.get(event.aggregateId) ?? null, event));
  }

  const settlementEvents = events
    .filter((event) => event.eventType === 'SettlementProcessed')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const event of settlementEvents) {
    applySettlementToOrders(orders, event);
  }

  return orders;
}
