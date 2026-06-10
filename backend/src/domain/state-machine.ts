import { EventType, OrderStatus } from '@prisma/client';
import { InvalidTransitionError } from '../lib/errors';

/** Order-aggregate events. SettlementProcessed lives on its own aggregate. */
export type OrderEventType = Exclude<EventType, 'SettlementProcessed'>;

/**
 * For each event: which current statuses it may fire from.
 * `null` means "the aggregate must not exist yet".
 *
 * Deliberate strictness worth calling out:
 * - PaymentProcessing is NOT allowed from PAYMENT_PROCESSING. A stuck attempt
 *   must be retried with the SAME idempotencyKey (which replays, not re-enters);
 *   allowing re-entry with a fresh key would let two live attempts race to the
 *   payment provider and double-charge the customer.
 * - PaymentConfirmed is allowed from CREATED as well, so the payment service can
 *   be driven directly (imports, tests) without the PaymentProcessing marker.
 * - Refunds are only reachable after money actually moved (PAID and later).
 */
const ALLOWED_FROM: Record<OrderEventType, ReadonlyArray<OrderStatus | null>> = {
  OrderCreated: [null],
  PaymentProcessing: [OrderStatus.CREATED, OrderStatus.PAYMENT_FAILED],
  PaymentConfirmed: [OrderStatus.CREATED, OrderStatus.PAYMENT_PROCESSING],
  PaymentFailed: [OrderStatus.PAYMENT_PROCESSING],
  FeeCalculated: [OrderStatus.PAID],
  OrderShipped: [OrderStatus.PAID],
  OrderDelivered: [OrderStatus.SHIPPED],
  OrderRefunded: [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.DELIVERED],
};

/** Status of the order after the event is applied. */
const NEXT_STATUS: Record<OrderEventType, OrderStatus> = {
  OrderCreated: OrderStatus.CREATED,
  PaymentProcessing: OrderStatus.PAYMENT_PROCESSING,
  PaymentConfirmed: OrderStatus.PAID,
  PaymentFailed: OrderStatus.PAYMENT_FAILED,
  // Fees are a financial annotation on a paid order, not a lifecycle step.
  FeeCalculated: OrderStatus.PAID,
  OrderShipped: OrderStatus.SHIPPED,
  OrderDelivered: OrderStatus.DELIVERED,
  OrderRefunded: OrderStatus.REFUNDED,
};

export function isTransitionAllowed(
  eventType: OrderEventType,
  currentStatus: OrderStatus | null,
): boolean {
  return ALLOWED_FROM[eventType].includes(currentStatus);
}

export function assertTransition(
  eventType: OrderEventType,
  currentStatus: OrderStatus | null,
  orderId: string,
): void {
  if (!isTransitionAllowed(eventType, currentStatus)) {
    throw new InvalidTransitionError(
      `Cannot apply ${eventType} to order "${orderId}" in status ${currentStatus ?? 'NONEXISTENT'}`,
      {
        orderId,
        eventType,
        currentStatus,
        allowedFrom: ALLOWED_FROM[eventType],
      },
    );
  }
}

export function nextStatus(eventType: OrderEventType): OrderStatus {
  return NEXT_STATUS[eventType];
}
