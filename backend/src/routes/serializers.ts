import { EventLog, OrderProjection, Settlement } from '@prisma/client';
import { toMoneyString } from '../lib/money';
import { LedgerEntryWithEvent } from '../services/queries';

/**
 * Single place where DB rows become wire JSON. Every amount leaves the API as
 * a fixed 4-dp decimal string; timestamps leave as ISO-8601 UTC strings.
 */

export function orderToJson(order: OrderProjection) {
  return {
    id: order.id,
    customerId: order.customerId,
    paymentMethod: order.paymentMethod,
    amount: toMoneyString(order.amount),
    feeAmount: order.feeAmount ? toMoneyString(order.feeAmount) : null,
    payoutAmount: order.payoutAmount ? toMoneyString(order.payoutAmount) : null,
    status: order.status,
    version: order.version,
    stripeChargeId: order.stripeChargeId,
    settlementId: order.settlementId,
    settledAt: order.settledAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

export function eventToJson(event: EventLog) {
  return {
    id: event.id,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: event.payload,
    version: event.version,
    timestamp: event.timestamp.toISOString(),
    idempotencyKey: event.idempotencyKey,
  };
}

export function ledgerEntryToJson(entry: LedgerEntryWithEvent) {
  return {
    id: entry.id,
    orderId: entry.orderId,
    eventId: entry.eventId,
    eventType: entry.event.eventType,
    eventVersion: entry.event.version,
    account: entry.account,
    debit: entry.debit ? toMoneyString(entry.debit) : null,
    credit: entry.credit ? toMoneyString(entry.credit) : null,
    runningBalance: toMoneyString(entry.runningBalance),
    timestamp: entry.timestamp.toISOString(),
  };
}

export function settlementToJson(settlement: Settlement) {
  return {
    settlementId: settlement.id,
    date: settlement.date,
    orderCount: settlement.orderCount,
    totalGross: toMoneyString(settlement.totalGross),
    totalFees: toMoneyString(settlement.totalFees),
    totalPayout: toMoneyString(settlement.totalPayout),
    createdAt: settlement.createdAt.toISOString(),
  };
}
