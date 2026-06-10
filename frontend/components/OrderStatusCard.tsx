'use client';

import { formatDateTime, formatUsd } from '@/lib/money';
import type { ApiOrder, LedgerVerification, OrderStatus } from '@/lib/types';
import { SettledBadge, StatusBadge } from './StatusBadge';

const HAPPY_PATH: Array<{ key: string; label: string; reached: (s: OrderStatus) => boolean }> = [
  { key: 'created', label: 'Created', reached: () => true },
  {
    key: 'paid',
    label: 'Paid',
    reached: (s) => ['PAID', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(s),
  },
  { key: 'shipped', label: 'Shipped', reached: (s) => ['SHIPPED', 'DELIVERED'].includes(s) },
  { key: 'delivered', label: 'Delivered', reached: (s) => s === 'DELIVERED' },
];

function Step({ label, done, last }: { label: string; done: boolean; last: boolean }) {
  return (
    <div className="flex flex-1 items-center">
      <div className="flex flex-col items-center">
        <span
          className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${
            done ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500'
          }`}
        >
          {done ? '✓' : ''}
        </span>
        <span className={`mt-1 text-[10px] ${done ? 'text-emerald-700' : 'text-slate-400'}`}>
          {label}
        </span>
      </div>
      {!last ? (
        <div className={`mx-1 mb-4 h-0.5 flex-1 rounded ${done ? 'bg-emerald-300' : 'bg-slate-200'}`} />
      ) : null}
    </div>
  );
}

/** B.1 — order amount, fee, payout, payment status. Polled in real time. */
export function OrderStatusCard({
  order,
  verification,
}: {
  order: ApiOrder;
  verification: LedgerVerification | undefined;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-500">{order.id}</p>
          <p className="tnum mt-1 text-3xl font-semibold tracking-tight">
            {formatUsd(order.amount)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {order.customerId} · {order.paymentMethod.replace('_', ' ')} · created{' '}
            {formatDateTime(order.createdAt)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex gap-1.5">
            {order.settlementId ? <SettledBadge /> : null}
            <StatusBadge status={order.status} />
          </div>
          {verification ? (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                verification.balanced
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : 'bg-rose-50 text-rose-700 ring-rose-200'
              }`}
              title={`Σdebits ${verification.sumDebits} − Σcredits ${verification.sumCredits} = ${verification.difference}`}
            >
              {verification.balanced ? 'Ledger balanced ✓' : `IMBALANCED ${verification.difference}`}
            </span>
          ) : null}
        </div>
      </div>

      {order.status !== 'REFUNDED' && order.status !== 'PAYMENT_FAILED' ? (
        <div className="mt-4 flex">
          {HAPPY_PATH.map((step, index) => (
            <Step
              key={step.key}
              label={step.label}
              done={step.reached(order.status)}
              last={index === HAPPY_PATH.length - 1}
            />
          ))}
        </div>
      ) : null}

      <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">Amount</dt>
          <dd className="tnum mt-0.5 text-sm font-semibold">{formatUsd(order.amount)}</dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">Fee (3%)</dt>
          <dd className="tnum mt-0.5 text-sm font-semibold text-amber-600">
            {order.feeAmount ? `− ${formatUsd(order.feeAmount)}` : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] uppercase tracking-wide text-slate-500">Seller payout</dt>
          <dd className="tnum mt-0.5 text-sm font-semibold text-emerald-600">
            {formatUsd(order.payoutAmount)}
          </dd>
        </div>
      </dl>

      <div className="mt-3 grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
        <p>
          Charge:{' '}
          {order.stripeChargeId ? (
            <span className="font-mono">{order.stripeChargeId}</span>
          ) : (
            'not charged yet'
          )}
          {order.paidAt ? ` · paid ${formatDateTime(order.paidAt)}` : ''}
        </p>
        <p className="sm:text-right">
          {order.settlementId
            ? `Settled in ${order.settlementId} (${formatDateTime(order.settledAt)})`
            : 'Not settled yet'}
        </p>
      </div>
    </section>
  );
}
