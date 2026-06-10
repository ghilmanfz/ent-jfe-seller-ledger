'use client';

import { formatUsd } from '@/lib/money';
import type { DashboardSummary } from '@/lib/types';

function Card({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`tnum mt-1 truncate text-2xl font-semibold ${accent ?? 'text-slate-900'}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export function SummaryCards({ summary }: { summary: DashboardSummary | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        label="Orders"
        value={summary ? String(summary.totalOrders) : '…'}
        hint={
          summary
            ? `${summary.byStatus.PAID ?? 0} paid · ${summary.byStatus.REFUNDED ?? 0} refunded`
            : undefined
        }
      />
      <Card label="Paid gross" value={summary ? formatUsd(summary.paidGross) : '…'} />
      <Card
        label="Fees (3%)"
        value={summary ? formatUsd(summary.totalFees) : '…'}
        accent="text-amber-600"
      />
      <Card
        label="Unsettled payout"
        value={summary ? formatUsd(summary.unsettledPayout) : '…'}
        hint={
          summary
            ? summary.lastSettlementDate
              ? `settled so far ${formatUsd(summary.settledPayout)} · last ${summary.lastSettlementDate}`
              : 'no settlement yet'
            : undefined
        }
        accent="text-emerald-600"
      />
    </div>
  );
}
