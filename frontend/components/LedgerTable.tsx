'use client';

import { formatDateTime } from '@/lib/money';
import type { AccountBreakdown, ApiLedgerEntry, LedgerTotals } from '@/lib/types';

const ACCOUNT_LABELS: Record<string, string> = {
  order_balance: 'Order balance',
  order_pending: 'Order pending',
  payment_received: 'Payment received',
  fees_owed: 'Fees owed',
  seller_payout: 'Seller payout',
};

/**
 * B.2 — full audit trail. Amounts are rendered as the EXACT 4-dp decimal
 * strings from the API (monospace), never reformatted through floats.
 */
export function LedgerTable({
  entries,
  totals,
  accounts,
}: {
  entries: ApiLedgerEntry[] | undefined;
  totals: LedgerTotals | undefined;
  accounts: AccountBreakdown[] | undefined;
}) {
  if (!entries) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
        Loading ledger…
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Ledger audit trail</h2>
        {totals ? (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
              totals.balanced
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-rose-50 text-rose-700 ring-rose-200'
            }`}
          >
            Σ debit {totals.sumDebits} = Σ credit {totals.sumCredits}
          </span>
        ) : null}
      </div>

      {/* Mobile: stacked entries */}
      <ul className="divide-y divide-slate-100 md:hidden">
        {entries.map((entry) => (
          <li key={entry.id} className="px-4 py-3">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                v{entry.eventVersion} · {entry.eventType}
              </span>
              <span>{formatDateTime(entry.timestamp)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-sm">{ACCOUNT_LABELS[entry.account] ?? entry.account}</span>
              <span className="tnum font-mono text-sm">
                {entry.debit ? (
                  <span className="text-slate-900">D {entry.debit}</span>
                ) : (
                  <span className="text-slate-500">C {entry.credit}</span>
                )}
              </span>
            </div>
            <div className="mt-0.5 text-right font-mono text-xs text-slate-400">
              bal {entry.runningBalance}
            </div>
          </li>
        ))}
      </ul>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-4 py-2 text-right font-medium">Debit</th>
              <th className="px-4 py-2 text-right font-medium">Credit</th>
              <th className="px-4 py-2 text-right font-medium">Running balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <tr key={entry.id} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">
                  {formatDateTime(entry.timestamp)}
                </td>
                <td className="px-4 py-2 text-xs">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                    v{entry.eventVersion}
                  </span>{' '}
                  {entry.eventType}
                </td>
                <td className="px-4 py-2">{ACCOUNT_LABELS[entry.account] ?? entry.account}</td>
                <td className="tnum px-4 py-2 text-right font-mono">
                  {entry.debit ?? <span className="text-slate-300">—</span>}
                </td>
                <td className="tnum px-4 py-2 text-right font-mono">
                  {entry.credit ?? <span className="text-slate-300">—</span>}
                </td>
                <td className="tnum px-4 py-2 text-right font-mono text-slate-500">
                  {entry.runningBalance}
                </td>
              </tr>
            ))}
          </tbody>
          {totals ? (
            <tfoot className="border-t border-slate-200 bg-slate-50 font-medium">
              <tr>
                <td colSpan={3} className="px-4 py-2 text-xs uppercase tracking-wide text-slate-500">
                  Totals ({totals.entryCount} entries)
                </td>
                <td className="tnum px-4 py-2 text-right font-mono">{totals.sumDebits}</td>
                <td className="tnum px-4 py-2 text-right font-mono">{totals.sumCredits}</td>
                <td
                  className={`tnum px-4 py-2 text-right font-mono ${
                    totals.balanced ? 'text-emerald-600' : 'text-rose-600'
                  }`}
                >
                  {totals.balanced ? 'balanced ✓' : `off by ${totals.difference}`}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {accounts && accounts.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 border-t border-slate-200 p-4 sm:grid-cols-5">
          {accounts.map((account) => (
            <div key={account.account} className="rounded-lg bg-slate-50 p-2 text-center">
              <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">
                {ACCOUNT_LABELS[account.account] ?? account.account}
              </p>
              <p className="tnum mt-0.5 font-mono text-xs font-semibold">{account.net}</p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
