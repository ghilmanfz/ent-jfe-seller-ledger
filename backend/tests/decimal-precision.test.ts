import { Prisma } from '@prisma/client';
import { calculateFee, parseMoney, toMoneyString } from '../src/lib/money';
import { ValidationError } from '../src/lib/errors';
import * as financial from '../src/services/financial-service';
import { createPaidOrder, money } from './helpers';

describe('decimal precision (Part C.2)', () => {
  it('computes 3% fees exactly — including the cases that break floats', () => {
    const cases: Array<[amount: string, fee: string, payout: string]> = [
      ['10.00', '0.3000', '9.7000'], // 10 * 0.03 = 0.30, exactly
      ['1.00', '0.0300', '0.9700'],
      ['0.01', '0.0003', '0.0097'],
      ['0.07', '0.0021', '0.0679'],
      ['19.99', '0.5997', '19.3903'],
      ['999999.99', '29999.9997', '969999.9903'],
      ['123.4567', '3.7037', '119.7530'], // 3.703701 -> half-up at 4 dp
      ['10.5555', '0.3167', '10.2388'], // 0.316665 -> rounds up
    ];
    for (const [amount, expectedFee, expectedPayout] of cases) {
      const fee = calculateFee(money(amount));
      expect(toMoneyString(fee)).toBe(expectedFee);
      expect(toMoneyString(money(amount).minus(fee))).toBe(expectedPayout);
    }
  });

  it('float arithmetic WOULD corrupt these numbers (sanity check on why Decimal exists)', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // the classic
    expect(new Prisma.Decimal('0.1').add('0.2').toFixed(4)).toBe('0.3000');

    // 100 fee postings of 0.0021: float drifts, Decimal does not.
    const floatSum = Array.from({ length: 100 }).reduce<number>((sum) => sum + 0.0021, 0);
    expect(floatSum).not.toBe(0.21);
    const decimalSum = Array.from({ length: 100 }).reduce<Prisma.Decimal>(
      (sum) => sum.add('0.0021'),
      new Prisma.Decimal(0),
    );
    expect(decimalSum.toFixed(4)).toBe('0.2100');
  });

  it('keeps every digit through the full pipeline for 999999.99 USD', async () => {
    const { order } = await createPaidOrder('999999.99');
    expect(toMoneyString(order.amount)).toBe('999999.9900');
    expect(order.feeAmount && toMoneyString(order.feeAmount)).toBe('29999.9997');
    expect(order.payoutAmount && toMoneyString(order.payoutAmount)).toBe('969999.9903');

    const verification = await financial.verifyLedgerBalance(order.id);
    expect(verification.balanced).toBe(true);
    expect(verification.difference).toBe('0.0000');
  });

  it('a 4-dp amount whose fee needs rounding still leaves the ledger balanced', async () => {
    const { order } = await createPaidOrder('10.5555'); // fee 0.316665 -> 0.3167
    expect(order.feeAmount && toMoneyString(order.feeAmount)).toBe('0.3167');
    expect(order.payoutAmount && toMoneyString(order.payoutAmount)).toBe('10.2388');
    const verification = await financial.verifyLedgerBalance(order.id);
    expect(verification.balanced).toBe(true);
  });

  it('rejects anything that is not a clean positive decimal string', () => {
    const bad = ['10.12345', '-5.00', '1e3', '10,00', 'abc', '', '.5', '+10', '10.'];
    for (const input of bad) {
      expect(() => parseMoney(input)).toThrow(ValidationError);
    }
    expect(() => parseMoney(123 as unknown as string)).toThrow(ValidationError); // numbers refused
    expect(toMoneyString(parseMoney('0.0001'))).toBe('0.0001'); // 4 dp accepted
  });
});
