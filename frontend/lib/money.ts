/**
 * Display-only formatting. The exact decimal STRINGS from the API are the
 * source of truth and are shown verbatim in the ledger; Number() conversion
 * here is purely cosmetic (currency symbol + thousands separators) and never
 * flows back into any calculation.
 */
export function formatUsd(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4, // keep sub-cent fee precision visible (e.g. $0.0021)
  }).format(numeric);
}

/** "2026-06-10T09:15:00.000Z" -> local, compact. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const then = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
