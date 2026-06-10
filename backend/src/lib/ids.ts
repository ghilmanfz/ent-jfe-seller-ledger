import { randomUUID } from 'node:crypto';

export function newOrderId(): string {
  return `ord_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** Settlements are their own aggregate, keyed by UTC calendar date. */
export function settlementAggregateId(date: string): string {
  return `settlement:${date}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

/** Exclusive upper bound of a UTC calendar day. */
export function endOfUtcDay(date: string): Date {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000);
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
