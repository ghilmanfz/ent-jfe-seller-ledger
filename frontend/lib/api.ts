import type {
  ApiOrder,
  ApiSettlement,
  DashboardSummary,
  LedgerVerification,
  OrderDetailResponse,
  OrderLedgerResponse,
  OrderListResponse,
  PaymentMethod,
  SettleResult,
} from './types';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'Cannot reach the API. Is the backend running?');
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = body as { error?: { code?: string; message?: string; details?: unknown } };
    throw new ApiRequestError(
      response.status,
      envelope?.error?.code ?? 'UNKNOWN_ERROR',
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      envelope?.error?.details,
    );
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(payload) });
}

/** SWR fetcher: keys are API paths. */
export const fetcher = <T>(path: string): Promise<T> => request<T>(path);

export interface MutationResponse {
  order: ApiOrder;
  replayed: boolean;
}

export const api = {
  summary: () => request<DashboardSummary>('/summary'),
  orders: (limit = 50) => request<OrderListResponse>(`/orders?limit=${limit}`),
  order: (id: string) => request<OrderDetailResponse>(`/orders/${id}`),
  ledger: (id: string) => request<OrderLedgerResponse>(`/orders/${id}/ledger`),
  verify: (id: string) => request<LedgerVerification>(`/verify-ledger/${encodeURIComponent(id)}`),
  settlements: () => request<{ settlements: ApiSettlement[] }>('/settlements'),

  createOrder: (body: {
    customerId: string;
    paymentMethod: PaymentMethod;
    amount: string;
    idempotencyKey: string;
  }) => post<MutationResponse>('/orders', body),
  payOrder: (id: string, idempotencyKey: string) =>
    post<MutationResponse & { payment: { chargeId: string } }>(
      `/orders/${encodeURIComponent(id)}/pay`,
      { idempotencyKey },
    ),
  shipOrder: (id: string, idempotencyKey: string) =>
    post<MutationResponse>(`/orders/${encodeURIComponent(id)}/ship`, { idempotencyKey }),
  deliverOrder: (id: string, idempotencyKey: string) =>
    post<MutationResponse>(`/orders/${encodeURIComponent(id)}/deliver`, { idempotencyKey }),
  refundOrder: (id: string, idempotencyKey: string, reason?: string) =>
    post<MutationResponse>(`/orders/${encodeURIComponent(id)}/refund`, { idempotencyKey, reason }),
  settle: (date: string, idempotencyKey: string) =>
    post<SettleResult>('/settle', { date, idempotencyKey }),
};
