'use client';

import useSWR from 'swr';
import { fetcher } from './api';
import type {
  ApiSettlement,
  DashboardSummary,
  LedgerVerification,
  OrderDetailResponse,
  OrderLedgerResponse,
  OrderListResponse,
} from './types';

/**
 * "Real-time" via short-interval polling. Honest trade-off for a serverless
 * frontend + tiny API: 2.5s staleness bound, zero connection management,
 * works through every proxy. SWR dedupes and revalidates on focus for free.
 * (Documented alternative: SSE/WebSockets — see docs/ARCHITECTURE.md.)
 */
export const POLL_MS = 2500;

const polling = { refreshInterval: POLL_MS, revalidateOnFocus: true } as const;

export function useSummary() {
  return useSWR<DashboardSummary>('/summary', fetcher, polling);
}

export function useOrders(limit = 50) {
  return useSWR<OrderListResponse>(`/orders?limit=${limit}`, fetcher, polling);
}

export function useOrder(orderId: string | null) {
  return useSWR<OrderDetailResponse>(orderId ? `/orders/${orderId}` : null, fetcher, polling);
}

export function useOrderLedger(orderId: string | null) {
  return useSWR<OrderLedgerResponse>(
    orderId ? `/orders/${orderId}/ledger` : null,
    fetcher,
    polling,
  );
}

export function useVerifyLedger(orderId: string | null) {
  return useSWR<LedgerVerification>(
    orderId ? `/verify-ledger/${orderId}` : null,
    fetcher,
    polling,
  );
}

export function useSettlements() {
  return useSWR<{ settlements: ApiSettlement[] }>('/settlements', fetcher, polling);
}
