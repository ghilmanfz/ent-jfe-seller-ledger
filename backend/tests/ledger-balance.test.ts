import { prisma } from '../src/lib/prisma';
import { LedgerImbalancedError } from '../src/lib/errors';
import { entry, validatePostings } from '../src/services/ledger';
import * as financial from '../src/services/financial-service';
import { createOrder, key, money } from './helpers';

function accountNet(verification: financial.LedgerVerification, account: string): string {
  return verification.accounts.find((a) => a.account === account)?.net ?? '0.0000';
}

describe('ledger balance invariant', () => {
  it('sum(debits) − sum(credits) = 0 after every lifecycle step, with the expected account nets', async () => {
    const created = await createOrder({ orderId: 'ord_ledger', amount: '100.00' });
    const orderId = created.order.id;

    let v = await financial.verifyLedgerBalance(orderId);
    expect(v.balanced).toBe(true);
    expect(accountNet(v, 'order_balance')).toBe('100.0000');
    expect(accountNet(v, 'order_pending')).toBe('-100.0000');

    await financial.processOrderPayment({ orderId, idempotencyKey: key('pay') });
    v = await financial.verifyLedgerBalance(orderId);
    expect(v.balanced).toBe(true);
    expect(accountNet(v, 'order_balance')).toBe('0.0000'); // paid off
    expect(accountNet(v, 'payment_received')).toBe('97.0000'); // net of 3% fee
    expect(accountNet(v, 'fees_owed')).toBe('3.0000');

    await financial.dailySettlement({ date: new Date().toISOString().slice(0, 10) });
    v = await financial.verifyLedgerBalance(orderId);
    expect(v.balanced).toBe(true);
    expect(accountNet(v, 'payment_received')).toBe('0.0000'); // swept into payout
    expect(accountNet(v, 'seller_payout')).toBe('97.0000');
  });

  it('database CHECK rejects a row having both debit and credit, or neither, or zero amounts', async () => {
    const created = await createOrder({ orderId: 'ord_check' });
    const eventId = created.event.id;

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ledger_entry" (id, order_id, event_id, account, debit, credit)
         VALUES (gen_random_uuid(), 'ord_check', '${eventId}', 'order_balance', 10.0, 10.0)`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ledger_entry" (id, order_id, event_id, account, debit, credit)
         VALUES (gen_random_uuid(), 'ord_check', '${eventId}', 'order_balance', NULL, NULL)`,
      ),
    ).rejects.toThrow(/check constraint/i);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "ledger_entry" (id, order_id, event_id, account, debit, credit)
         VALUES (gen_random_uuid(), 'ord_check', '${eventId}', 'order_balance', 0, NULL)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it('append-only triggers block UPDATE and DELETE on event_log and ledger_entry', async () => {
    await createOrder({ orderId: 'ord_immutable' });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "event_log" SET version = 99`),
    ).rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "event_log"`)).rejects.toThrow(
      /append-only/i,
    );
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ledger_entry" SET debit = 1`),
    ).rejects.toThrow(/append-only/i);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "ledger_entry"`)).rejects.toThrow(
      /append-only/i,
    );
  });

  it('application layer refuses unbalanced or malformed posting sets before SQL is even attempted', () => {
    expect(() => validatePostings([entry.debit('order_balance', money('10'))])).toThrow(
      LedgerImbalancedError,
    );
    expect(() =>
      validatePostings([
        entry.debit('order_balance', money('10')),
        entry.credit('order_pending', money('9.9999')),
      ]),
    ).toThrow(LedgerImbalancedError);
    expect(() =>
      validatePostings([
        { account: 'order_balance', debit: money('5'), credit: money('5') },
        entry.credit('order_pending', money('5')),
      ]),
    ).toThrow(LedgerImbalancedError);
    expect(() =>
      validatePostings([
        entry.debit('order_balance', money('0')),
        entry.credit('order_pending', money('0')),
      ]),
    ).toThrow(LedgerImbalancedError);
  });
});
