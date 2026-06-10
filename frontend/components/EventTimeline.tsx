'use client';

import { formatDateTime } from '@/lib/money';
import type { ApiEvent } from '@/lib/types';

const EVENT_COLORS: Record<string, string> = {
  OrderCreated: 'bg-slate-400',
  PaymentProcessing: 'bg-amber-400',
  PaymentConfirmed: 'bg-emerald-500',
  PaymentFailed: 'bg-rose-500',
  FeeCalculated: 'bg-amber-500',
  OrderShipped: 'bg-sky-500',
  OrderDelivered: 'bg-indigo-500',
  OrderRefunded: 'bg-orange-500',
};

/** The raw, append-only history — what an auditor would read. */
export function EventTimeline({ events }: { events: ApiEvent[] | undefined }) {
  if (!events) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold">Event history</h2>
      <ol className="mt-3 space-y-0">
        {events.map((event, index) => (
          <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
            {index < events.length - 1 ? (
              <span className="absolute left-[5px] top-4 h-full w-px bg-slate-200" />
            ) : null}
            <span
              className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ring-2 ring-white ${
                EVENT_COLORS[event.eventType] ?? 'bg-slate-300'
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <p className="text-sm font-medium">
                  {event.eventType}
                  <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                    v{event.version}
                  </span>
                </p>
                <p className="text-xs text-slate-500">{formatDateTime(event.timestamp)}</p>
              </div>
              <details className="mt-0.5 text-xs text-slate-500">
                <summary className="cursor-pointer select-none hover:text-slate-700">
                  payload
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
