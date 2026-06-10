import { createHash } from 'node:crypto';
import { config } from '../config';
import { CardDeclinedError, StripeApiError } from '../lib/errors';
import { Money, toMoneyString } from '../lib/money';

/**
 * Deterministic mock of Stripe's charge API.
 *
 * Idempotency works like the real thing: the chargeId is derived purely from
 * the idempotencyKey, so retrying the same key always yields the same charge
 * and can never double-charge. Being stateless, this survives restarts and
 * multiple instances without shared storage.
 *
 * Failure simulation via magic customer ids (like Stripe's test cards):
 *   *_declined      -> CardDeclinedError("card_declined")        HTTP 402, terminal
 *   *_insufficient  -> CardDeclinedError("insufficient_funds")   HTTP 402, terminal
 *   *_unavailable   -> StripeApiError                            HTTP 502, transient:
 *                      retry with the SAME idempotencyKey
 */

export interface StripeCharge {
  chargeId: string;
  status: 'succeeded';
  amount: string;
  currency: 'usd';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processPayment(args: {
  orderId: string;
  amount: Money;
  customerId: string;
  idempotencyKey: string;
}): Promise<StripeCharge> {
  if (config.STRIPE_MOCK_LATENCY_MS > 0) {
    // Simulated network latency keeps concurrency bugs honest in dev/demo.
    const jitter = Math.floor(Math.random() * config.STRIPE_MOCK_LATENCY_MS);
    await sleep(config.STRIPE_MOCK_LATENCY_MS / 2 + jitter);
  }

  if (args.customerId.endsWith('_declined')) {
    throw new CardDeclinedError('card_declined');
  }
  if (args.customerId.endsWith('_insufficient')) {
    throw new CardDeclinedError('insufficient_funds');
  }
  if (args.customerId.endsWith('_unavailable')) {
    throw new StripeApiError();
  }

  const chargeId = `ch_${createHash('sha256').update(args.idempotencyKey).digest('hex').slice(0, 24)}`;
  return {
    chargeId,
    status: 'succeeded',
    amount: toMoneyString(args.amount),
    currency: 'usd',
  };
}
