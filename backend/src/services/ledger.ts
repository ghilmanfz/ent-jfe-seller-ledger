import { LedgerAccount, Prisma } from '@prisma/client';
import { LedgerImbalancedError } from '../lib/errors';
import { Money, toMoneyString, ZERO } from '../lib/money';
import { Tx } from '../lib/prisma';

/**
 * Double-entry posting rules. Every financial event writes a *balanced set* of
 * ledger rows in the same transaction as the event itself:
 *
 *   OrderCreated      ->  DEBIT order_balance      / CREDIT order_pending
 *   PaymentConfirmed  ->  DEBIT payment_received   / CREDIT order_balance
 *   FeeCalculated     ->  DEBIT fees_owed          / CREDIT payment_received
 *   SettlementProcessed -> DEBIT seller_payout     / CREDIT payment_received   (per order)
 *   OrderRefunded     ->  exact reversals of the three postings above
 *
 * Because each set balances, sum(debits) === sum(credits) holds for every
 * order and for the ledger as a whole, at every point in time.
 */

export interface Posting {
  account: LedgerAccount;
  debit?: Money;
  credit?: Money;
}

export const entry = {
  debit: (account: LedgerAccount, amount: Money): Posting => ({ account, debit: amount }),
  credit: (account: LedgerAccount, amount: Money): Posting => ({ account, credit: amount }),
};

/**
 * App-level mirror of the DB CHECK constraints (defense in depth): exactly one
 * side per row, strictly positive amounts, and the set must balance.
 */
export function validatePostings(postings: Posting[]): { debits: Money; credits: Money } {
  let debits = ZERO;
  let credits = ZERO;
  for (const posting of postings) {
    const hasDebit = posting.debit !== undefined;
    const hasCredit = posting.credit !== undefined;
    if (hasDebit === hasCredit) {
      throw new LedgerImbalancedError(
        `Posting on account "${posting.account}" must have exactly one of debit/credit`,
      );
    }
    const amount = hasDebit ? posting.debit : posting.credit;
    if (!amount || amount.lte(ZERO)) {
      throw new LedgerImbalancedError(
        `Posting on account "${posting.account}" must be strictly positive`,
      );
    }
    debits = debits.add(posting.debit ?? ZERO);
    credits = credits.add(posting.credit ?? ZERO);
  }
  if (!debits.equals(credits)) {
    throw new LedgerImbalancedError(
      `Refusing unbalanced posting set: debits ${toMoneyString(debits)} != credits ${toMoneyString(credits)}`,
    );
  }
  return { debits, credits };
}

export function toLedgerRows(args: {
  orderId: string;
  eventId: string;
  postings: Posting[];
}): Prisma.LedgerEntryCreateManyInput[] {
  validatePostings(args.postings);
  return args.postings.map((posting) => ({
    orderId: args.orderId,
    eventId: args.eventId,
    account: posting.account,
    debit: posting.debit ?? null,
    credit: posting.credit ?? null,
  }));
}

/** Append a balanced posting set, atomically with the event that caused it. */
export async function postLedger(
  tx: Tx,
  args: { orderId: string; eventId: string; postings: Posting[] },
): Promise<void> {
  if (args.postings.length === 0) return;
  await tx.ledgerEntry.createMany({ data: toLedgerRows(args) });
}
