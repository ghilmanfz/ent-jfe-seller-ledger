'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { api, ApiRequestError } from '@/lib/api';
import { actionKey, clearActionKey } from '@/lib/idempotency';
import type { ApiOrder } from '@/lib/types';

type ActionName = 'pay' | 'ship' | 'deliver' | 'refund';

/**
 * Each button reuses ONE idempotencyKey per (order, action) until the action
 * succeeds (lib/idempotency.ts). Retrying a failed/half-finished payment —
 * including the simulated Stripe outage — therefore RESUMES the same attempt
 * instead of starting a second charge.
 */
export function OrderActions({ order }: { order: ApiOrder }) {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState<ActionName | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  async function run(action: ActionName, exec: (key: string) => Promise<unknown>) {
    if (busy) return;
    setBusy(action);
    setMessage(null);
    const scope = `${action}:${order.id}`;
    try {
      await exec(actionKey(scope));
      clearActionKey(scope); // success — next click is a NEW intent
      setMessage({ kind: 'ok', text: `${action} OK` });
      void mutate((key) => typeof key === 'string' && key.includes(order.id));
      void mutate((key) => typeof key === 'string' && key.startsWith('/orders?'));
      void mutate('/summary');
    } catch (cause) {
      if (cause instanceof ApiRequestError) {
        const retryable = cause.code === 'STRIPE_ERROR' || cause.code === 'NETWORK_ERROR';
        setMessage({
          kind: 'error',
          text: `${cause.message}${retryable ? ' — click again to retry with the SAME idempotency key.' : ''}`,
        });
        if (cause.code === 'CARD_DECLINED') clearActionKey(scope); // terminal: new attempt = new key
      } else {
        setMessage({ kind: 'error', text: 'Unexpected error' });
      }
    } finally {
      setBusy(null);
    }
  }

  const canPay = ['CREATED', 'PAYMENT_FAILED', 'PAYMENT_PROCESSING'].includes(order.status);
  const canShip = order.status === 'PAID';
  const canDeliver = order.status === 'SHIPPED';
  const canRefund =
    ['PAID', 'SHIPPED', 'DELIVERED'].includes(order.status) && order.settlementId === null;

  if (!canPay && !canShip && !canDeliver && !canRefund) {
    return message ? <ActionMessage message={message} /> : null;
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Actions</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {canPay ? (
          <button
            onClick={() => void run('pay', (key) => api.payOrder(order.id, key))}
            disabled={busy !== null}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50"
          >
            {busy === 'pay'
              ? 'Charging…'
              : order.status === 'PAYMENT_PROCESSING'
                ? 'Resume payment (same key)'
                : order.status === 'PAYMENT_FAILED'
                  ? 'Retry payment'
                  : 'Pay now'}
          </button>
        ) : null}
        {canShip ? (
          <button
            onClick={() => void run('ship', (key) => api.shipOrder(order.id, key))}
            disabled={busy !== null}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            {busy === 'ship' ? 'Shipping…' : 'Mark shipped'}
          </button>
        ) : null}
        {canDeliver ? (
          <button
            onClick={() => void run('deliver', (key) => api.deliverOrder(order.id, key))}
            disabled={busy !== null}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy === 'deliver' ? 'Delivering…' : 'Mark delivered'}
          </button>
        ) : null}
        {canRefund ? (
          <button
            onClick={() =>
              void run('refund', (key) => api.refundOrder(order.id, key, 'requested via dashboard'))
            }
            disabled={busy !== null}
            className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
          >
            {busy === 'refund' ? 'Refunding…' : 'Refund'}
          </button>
        ) : null}
      </div>
      {message ? <ActionMessage message={message} /> : null}
    </section>
  );
}

function ActionMessage({ message }: { message: { kind: 'ok' | 'error'; text: string } }) {
  return (
    <p
      className={`mt-3 rounded-lg px-3 py-2 text-sm ${
        message.kind === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
      }`}
    >
      {message.text}
    </p>
  );
}
