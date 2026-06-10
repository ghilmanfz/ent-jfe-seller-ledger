import { Prisma } from '@prisma/client';
import { ValidationError } from './errors';

/**
 * All money in the system is Prisma.Decimal (decimal.js under the hood):
 * exact base-10 arithmetic, no binary-float drift. Amounts cross the API
 * boundary as strings and are stored as DECIMAL(18,4) / JSON strings.
 */
export type Money = Prisma.Decimal;
export const Decimal = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);
export const FEE_RATE = new Prisma.Decimal('0.03'); // 3% platform fee

// Positive decimal string, at most 4 decimal places, no sign/exponent/commas.
const MONEY_RE = /^\d{1,14}(\.\d{1,4})?$/;

// Business cap, comfortably inside DECIMAL(18,4)'s 14 integer digits.
export const MAX_AMOUNT = new Prisma.Decimal('99999999999.9999');
// Smallest chargeable order: one cent. Keeps the 3% fee strictly positive
// (0.01 -> 0.0003), which the ledger CHECK constraints require.
export const MIN_ORDER_AMOUNT = new Prisma.Decimal('0.01');

/** Parse and validate an amount string coming from the outside world. */
export function parseMoney(raw: unknown, field = 'amount'): Money {
  if (typeof raw !== 'string' || !MONEY_RE.test(raw)) {
    throw new ValidationError(
      `${field} must be a positive decimal string with at most 4 decimal places (e.g. "100.00"); numbers are rejected to avoid float precision loss`,
    );
  }
  const value = new Prisma.Decimal(raw);
  if (value.lte(ZERO)) {
    throw new ValidationError(`${field} must be greater than 0`);
  }
  if (value.gt(MAX_AMOUNT)) {
    throw new ValidationError(`${field} exceeds the maximum supported amount (${MAX_AMOUNT.toFixed(4)})`);
  }
  return value;
}

export function parseOrderAmount(raw: unknown, field = 'amount'): Money {
  const value = parseMoney(raw, field);
  if (value.lt(MIN_ORDER_AMOUNT)) {
    throw new ValidationError(`${field} must be at least ${MIN_ORDER_AMOUNT.toFixed(2)} USD`);
  }
  return value;
}

/** Canonical wire/JSON representation: fixed 4 decimal places. */
export function toMoneyString(value: Money): string {
  return value.toFixed(4);
}

/**
 * The ONLY place in the system where rounding may happen.
 * fee = amount × 3%, rounded half-up to 4 dp. The rounded figure is then used
 * for BOTH ledger legs (debit fees_owed / credit payment_received), so a
 * rounded fee can never unbalance the ledger.
 */
export function calculateFee(amount: Money): Money {
  return amount.mul(FEE_RATE).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

export function isSameAmount(a: Money, b: Money): boolean {
  return a.equals(b);
}
