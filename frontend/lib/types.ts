/** Wire types of the backend API. Every monetary value is a 4-dp decimal STRING. */

export type OrderStatus =
  | 'CREATED'
  | 'PAYMENT_PROCESSING'
  | 'PAYMENT_FAILED'
  | 'PAID'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'REFUNDED';

export type PaymentMethod = 'card' | 'bank_transfer' | 'wallet';

export interface ApiOrder {
  id: string;
  customerId: string;
  paymentMethod: PaymentMethod;
  amount: string;
  feeAmount: string | null;
  payoutAmount: string | null;
  status: OrderStatus;
  version: number;
  stripeChargeId: string | null;
  settlementId: string | null;
  settledAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  version: number;
  timestamp: string;
  idempotencyKey: string;
}

export type LedgerAccount =
  | 'order_balance'
  | 'order_pending'
  | 'payment_received'
  | 'fees_owed'
  | 'seller_payout';

export interface ApiLedgerEntry {
  id: string;
  orderId: string;
  eventId: string;
  eventType: string;
  eventVersion: number;
  account: LedgerAccount;
  debit: string | null;
  credit: string | null;
  runningBalance: string;
  timestamp: string;
}

export interface LedgerTotals {
  entryCount: number;
  sumDebits: string;
  sumCredits: string;
  difference: string;
  balanced: boolean;
}

export interface AccountBreakdown {
  account: LedgerAccount;
  debits: string;
  credits: string;
  net: string;
}

export interface LedgerVerification {
  scope: 'order' | 'global';
  orderId: string | null;
  entryCount: number;
  sumDebits: string;
  sumCredits: string;
  difference: string;
  balanced: boolean;
  accounts: AccountBreakdown[];
}

export interface DashboardSummary {
  totalOrders: number;
  byStatus: Partial<Record<OrderStatus, number>>;
  paidGross: string;
  totalFees: string;
  unsettledPayout: string;
  settledPayout: string;
  lastSettlementDate: string | null;
}

export interface ApiSettlement {
  settlementId: string;
  date: string;
  orderCount: number;
  totalGross: string;
  totalFees: string;
  totalPayout: string;
  createdAt: string;
}

export interface SettleResult {
  settlementId: string;
  date: string;
  orderCount: number;
  totalGross: string;
  totalFees: string;
  totalPayout: string;
  alreadySettled: boolean;
}

export interface OrderDetailResponse {
  order: ApiOrder;
  events: ApiEvent[];
}

export interface OrderLedgerResponse {
  order: ApiOrder;
  entries: ApiLedgerEntry[];
  totals: LedgerTotals;
  accounts: AccountBreakdown[];
}

export interface OrderListResponse {
  orders: ApiOrder[];
  nextCursor: string | null;
}
