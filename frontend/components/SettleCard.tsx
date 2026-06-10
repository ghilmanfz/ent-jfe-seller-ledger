'use client';

import { useState } from 'react';
import { useSWRConfig } from 'swr';
import { api, ApiRequestError } from '@/lib/api';
import { formatUsd } from '@/lib/money';
import { useSettlements } from '@/lib/hooks';
import type { SettleResult } from '@/lib/types';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SettleCard() {
  const { mutate } = useSWRConfig();
  const { data } = useSettlements();
  const [date, setDate] = useState(todayUtc());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SettleResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function settle() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // Settlement is idempotent on the DATE — a random key per click is safe
      // and proves it: settling twice returns the identical stored result.
      const response = await api.settle(date, crypto.randomUUID());
      setResult(response);
      void mutate((key) => typeof key === 'string' && key.startsWith('/orders'));
      void mutate('/summary');
      void mutate('/settlements');
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  const latest = data?.settlements[0];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Daily settlement</h2>
      <p className="mt-1 text-xs text-slate-500">
        Sweeps every unsettled paid order (UTC date) into <code>seller_payout</code>. Running it
        again for the same date replays the original result.
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        <button
          onClick={() => void settle()}
          disabled={busy}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? 'Settling…' : 'Run settlement'}
        </button>
      </div>
      {result ? (
        <div
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${result.alreadySettled ? 'bg-slate-50 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}
        >
          {result.alreadySettled ? 'Already settled (replayed): ' : 'Settled: '}
          <strong>{result.orderCount}</strong> orders · payout{' '}
          <strong className="tnum">{formatUsd(result.totalPayout)}</strong> (fees{' '}
          <span className="tnum">{formatUsd(result.totalFees)}</span>)
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
      {latest ? (
        <p className="mt-3 text-xs text-slate-400">
          Last settlement {latest.date}: {latest.orderCount} orders,{' '}
          <span className="tnum">{formatUsd(latest.totalPayout)}</span>
        </p>
      ) : null}
    </div>
  );
}
