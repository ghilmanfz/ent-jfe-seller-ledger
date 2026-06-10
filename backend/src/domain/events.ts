import { PaymentMethod } from '@prisma/client';

/**
 * Typed event payloads, exactly as persisted in EventLog.payload.
 * Every monetary value is a 4-dp decimal STRING ("100.0000") — JSON numbers
 * are IEEE-754 floats and must never carry money.
 */

export interface OrderCreatedPayload {
  orderId: string;
  customerId: string;
  paymentMethod: PaymentMethod;
  amount: string;
}

export interface PaymentProcessingPayload {
  orderId: string;
  amount: string;
  customerId: string;
}

export interface PaymentConfirmedPayload {
  orderId: string;
  amount: string;
  stripeChargeId: string;
}

export interface PaymentFailedPayload {
  orderId: string;
  amount: string;
  reason: string;
}

export interface FeeCalculatedPayload {
  orderId: string;
  baseAmount: string;
  feeRate: string; // "0.03"
  feeAmount: string;
  payoutAmount: string;
}

export interface OrderShippedPayload {
  orderId: string;
}

export interface OrderDeliveredPayload {
  orderId: string;
}

export interface OrderRefundedPayload {
  orderId: string;
  amount: string;
  feeAmount: string;
  reason: string | null;
}

export interface SettlementOrderLine {
  orderId: string;
  payout: string;
}

export interface SettlementProcessedPayload {
  date: string; // YYYY-MM-DD (UTC)
  orderCount: number;
  totalGross: string;
  totalFees: string;
  totalPayout: string;
  orders: SettlementOrderLine[];
}
