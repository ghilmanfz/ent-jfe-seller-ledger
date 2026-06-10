import type { OrderStatus } from '@/lib/types';

const STYLES: Record<OrderStatus, { label: string; className: string }> = {
  CREATED: { label: 'Created', className: 'bg-slate-100 text-slate-700 ring-slate-200' },
  PAYMENT_PROCESSING: {
    label: 'Processing',
    className: 'bg-amber-50 text-amber-700 ring-amber-200 animate-pulse',
  },
  PAYMENT_FAILED: { label: 'Payment failed', className: 'bg-rose-50 text-rose-700 ring-rose-200' },
  PAID: { label: 'Paid', className: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  SHIPPED: { label: 'Shipped', className: 'bg-sky-50 text-sky-700 ring-sky-200' },
  DELIVERED: { label: 'Delivered', className: 'bg-indigo-50 text-indigo-700 ring-indigo-200' },
  REFUNDED: { label: 'Refunded', className: 'bg-orange-50 text-orange-700 ring-orange-200' },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const style = STYLES[status];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${style.className}`}
    >
      {style.label}
    </span>
  );
}

export function SettledBadge() {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-violet-200">
      Settled
    </span>
  );
}
