'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { EventTimeline } from '@/components/EventTimeline';
import { LedgerTable } from '@/components/LedgerTable';
import { LiveIndicator } from '@/components/LiveIndicator';
import { OrderActions } from '@/components/OrderActions';
import { OrderStatusCard } from '@/components/OrderStatusCard';
import { ApiRequestError } from '@/lib/api';
import { useOrder, useOrderLedger, useVerifyLedger } from '@/lib/hooks';

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? null;

  const { data: detail, error, isValidating } = useOrder(orderId);
  const { data: ledger } = useOrderLedger(orderId);
  const { data: verification } = useVerifyLedger(orderId);

  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => {
    if (!isValidating && detail) setUpdatedAt(new Date());
  }, [isValidating, detail]);

  if (error instanceof ApiRequestError && error.status === 404) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
        <p className="text-sm text-slate-600">Order not found.</p>
        <Link href="/" className="mt-2 inline-block text-sm text-sky-700 hover:underline">
          ← Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link href="/" className="text-sm text-slate-500 hover:text-slate-900">
          ← Dashboard
        </Link>
        <LiveIndicator updatedAt={updatedAt} />
      </div>

      {detail ? (
        <>
          <OrderStatusCard order={detail.order} verification={verification} />
          <OrderActions order={detail.order} />
          <LedgerTable
            entries={ledger?.entries}
            totals={ledger?.totals}
            accounts={ledger?.accounts}
          />
          <EventTimeline events={detail.events} />
        </>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">
          Loading order…
        </div>
      )}
    </div>
  );
}
