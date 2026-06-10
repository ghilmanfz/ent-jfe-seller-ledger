'use client';

import Link from 'next/link';
import { formatUsd, timeAgo } from '@/lib/money';
import type { ApiOrder } from '@/lib/types';
import { SettledBadge, StatusBadge } from './StatusBadge';

/** Desktop: table. Mobile: stacked cards. Same data, mobile-first. */
export function OrdersTable({ orders }: { orders: ApiOrder[] | undefined }) {
  if (!orders) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        Loading orders…
      </div>
    );
  }
  if (orders.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        No orders yet — create one above to see the ledger in action.
      </div>
    );
  }

  return (
    <>
      {/* Mobile cards */}
      <ul className="space-y-2 md:hidden">
        {orders.map((order) => (
          <li key={order.id}>
            <Link
              href={`/orders/${order.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-3 shadow-sm active:bg-slate-50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs text-slate-500">{order.id}</span>
                <div className="flex shrink-0 gap-1">
                  {order.settlementId ? <SettledBadge /> : null}
                  <StatusBadge status={order.status} />
                </div>
              </div>
              <div className="mt-2 flex items-baseline justify-between">
                <span className="tnum text-lg font-semibold">{formatUsd(order.amount)}</span>
                <span className="text-xs text-slate-500">{timeAgo(order.createdAt)}</span>
              </div>
              <div className="mt-1 flex justify-between text-xs text-slate-500">
                <span>{order.customerId}</span>
                <span className="tnum">
                  fee {formatUsd(order.feeAmount)} · payout {formatUsd(order.payoutAmount)}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Order</th>
              <th className="px-4 py-2.5 font-medium">Customer</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 text-right font-medium">Fee (3%)</th>
              <th className="px-4 py-2.5 text-right font-medium">Payout</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 text-right font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.map((order) => (
              <tr key={order.id} className="transition hover:bg-slate-50">
                <td className="px-4 py-2.5">
                  <Link
                    href={`/orders/${order.id}`}
                    className="font-mono text-xs text-sky-700 hover:underline"
                  >
                    {order.id}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-slate-600">{order.customerId}</td>
                <td className="tnum px-4 py-2.5 text-right font-medium">
                  {formatUsd(order.amount)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-slate-500">
                  {formatUsd(order.feeAmount)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-slate-500">
                  {formatUsd(order.payoutAmount)}
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex gap-1">
                    <StatusBadge status={order.status} />
                    {order.settlementId ? <SettledBadge /> : null}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-500">
                  {timeAgo(order.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
