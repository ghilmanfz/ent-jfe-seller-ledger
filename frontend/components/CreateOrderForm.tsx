'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSWRConfig } from 'swr';
import { api, ApiRequestError } from '@/lib/api';
import type { PaymentMethod } from '@/lib/types';

/**
 * The idempotencyKey is minted when the user STARTS a submission and reused on
 * every retry of that submission; only success clears it. Mash the button all
 * you like — exactly one order is recorded.
 */
export function CreateOrderForm() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [customerId, setCustomerId] = useState('cus_alice');
  const [amount, setAmount] = useState('100.00');
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const idempotencyKey = pendingKey ?? crypto.randomUUID();
    setPendingKey(idempotencyKey); // survives a failed attempt -> retry replays
    try {
      const result = await api.createOrder({
        customerId: customerId.trim(),
        paymentMethod: method,
        amount: amount.trim(),
        idempotencyKey,
      });
      setPendingKey(null);
      void mutate((key) => typeof key === 'string' && key.startsWith('/orders'));
      void mutate('/summary');
      router.push(`/orders/${result.order.id}`);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Unexpected error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">New order</h2>
        <p className="text-xs text-slate-400">idempotent — double-click safe</p>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Customer</span>
          <input
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            list="demo-customers"
            required
            minLength={3}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="cus_alice"
          />
          <datalist id="demo-customers">
            <option value="cus_alice">normal</option>
            <option value="cus_bob">normal</option>
            <option value="cus_eve_declined">card always declined</option>
            <option value="cus_zoe_insufficient">insufficient funds</option>
            <option value="cus_max_unavailable">stripe outage (retryable)</option>
          </datalist>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Amount (USD)</span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
            inputMode="decimal"
            pattern="^\d{1,14}(\.\d{1,4})?$"
            title="Positive decimal with up to 4 decimal places"
            className="tnum w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="100.00"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">Method</span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
          >
            <option value="card">card</option>
            <option value="bank_transfer">bank transfer</option>
            <option value="wallet">wallet</option>
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-50 sm:w-auto"
          >
            {busy ? 'Recording…' : 'Create order'}
          </button>
        </div>
      </div>
      {error ? <p className="mt-2 text-sm text-rose-600">{error}</p> : null}
    </form>
  );
}
