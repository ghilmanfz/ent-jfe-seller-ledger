import {
  EventLog,
  LedgerAccount,
  OrderProjection,
  OrderStatus,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import * as payloads from '../domain/events';
import { assertTransition, nextStatus, OrderEventType } from '../domain/state-machine';
import {
  CardDeclinedError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
} from '../lib/errors';
import { endOfUtcDay, isValidDateString, newOrderId, settlementAggregateId } from '../lib/ids';
import {
  calculateFee,
  Decimal,
  FEE_RATE,
  isSameAmount,
  Money,
  toMoneyString,
  ZERO,
} from '../lib/money';
import { prisma, Tx } from '../lib/prisma';
import {
  appendEvent,
  isUniqueViolation,
  latestEvent,
  withIdempotentEvent,
} from './event-store';
import { entry, postLedger, toLedgerRows } from './ledger';
import * as stripe from './stripe-mock';

export interface MutationResult {
  order: OrderProjection;
  event: EventLog;
  /** true when this call returned a previously stored outcome (idempotent hit). */
  replayed: boolean;
}

const SETTLEABLE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/* ------------------------------------------------------------------------ *
 * Shared internals
 * ------------------------------------------------------------------------ */

async function replayOrderResult(existing: EventLog): Promise<MutationResult> {
  const order = await prisma.orderProjection.findUnique({
    where: { id: existing.aggregateId },
  });
  if (!order) {
    // Can only happen if someone bypassed the service layer.
    throw new NotFoundError(`Order "${existing.aggregateId}" missing for stored event ${existing.id}`);
  }
  return { order, event: existing, replayed: true };
}

async function getOrderOrThrow(tx: Tx, orderId: string): Promise<OrderProjection> {
  const order = await tx.orderProjection.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError(`Order "${orderId}" not found`);
  return order;
}

/**
 * Optimistically-guarded projection update: only applies if the row still has
 * the version (and any extra predicates) we based our decision on. A count of
 * 0 means another writer got there first — abort and roll the whole event
 * transaction back.
 */
async function updateProjectionGuarded(
  tx: Tx,
  current: OrderProjection,
  data: Prisma.OrderProjectionUpdateManyMutationInput,
  extraWhere: Prisma.OrderProjectionWhereInput = {},
): Promise<OrderProjection> {
  const result = await tx.orderProjection.updateMany({
    where: { id: current.id, version: current.version, ...extraWhere },
    data,
  });
  if (result.count !== 1) {
    throw new VersionConflictError(current.id, current.version + 1);
  }
  return tx.orderProjection.findUniqueOrThrow({ where: { id: current.id } });
}

/** Status-only order events (no money movement): processing/failed/ship/deliver. */
async function appendStatusEvent(args: {
  orderId: string;
  eventType: Extract<
    OrderEventType,
    'PaymentProcessing' | 'PaymentFailed' | 'OrderShipped' | 'OrderDelivered'
  >;
  idempotencyKey: string;
  buildPayload: (order: OrderProjection) => object;
}): Promise<MutationResult> {
  return withIdempotentEvent({
    key: args.idempotencyKey,
    intent: { eventType: args.eventType, aggregateId: args.orderId },
    replay: replayOrderResult,
    execute: () =>
      prisma.$transaction(async (tx) => {
        const order = await getOrderOrThrow(tx, args.orderId);
        assertTransition(args.eventType, order.status, order.id);
        const last = await latestEvent(tx, order.id);
        const version = (last?.version ?? 0) + 1;
        const event = await appendEvent(tx, {
          aggregateId: order.id,
          eventType: args.eventType,
          payload: args.buildPayload(order),
          version,
          idempotencyKey: args.idempotencyKey,
        });
        const updated = await updateProjectionGuarded(tx, order, {
          status: nextStatus(args.eventType),
          version,
        });
        return { order: updated, event, replayed: false };
      }),
  });
}

/* ------------------------------------------------------------------------ *
 * A.2 — recordOrder
 * ------------------------------------------------------------------------ */

export interface RecordOrderArgs {
  orderId?: string | undefined;
  customerId: string;
  paymentMethod: PaymentMethod;
  amount: Money;
  idempotencyKey: string;
}

/**
 * OrderCreated + ledger: DEBIT order_balance / CREDIT order_pending.
 * Atomic: event, ledger pair and projection commit or roll back together.
 */
export async function recordOrder(args: RecordOrderArgs): Promise<MutationResult> {
  const amountStr = toMoneyString(args.amount);
  return withIdempotentEvent({
    key: args.idempotencyKey,
    intent: {
      eventType: 'OrderCreated',
      aggregateId: args.orderId,
      match: { amount: amountStr, customerId: args.customerId },
    },
    replay: replayOrderResult,
    execute: () =>
      prisma.$transaction(async (tx) => {
        const orderId = args.orderId ?? newOrderId();
        const existing = await tx.orderProjection.findUnique({ where: { id: orderId } });
        assertTransition('OrderCreated', existing?.status ?? null, orderId);

        const payload: payloads.OrderCreatedPayload = {
          orderId,
          customerId: args.customerId,
          paymentMethod: args.paymentMethod,
          amount: amountStr,
        };
        const event = await appendEvent(tx, {
          aggregateId: orderId,
          eventType: 'OrderCreated',
          payload,
          version: 1,
          idempotencyKey: args.idempotencyKey,
        });
        // Projection row must exist before ledger rows (FK), same transaction.
        const order = await tx.orderProjection.create({
          data: {
            id: orderId,
            customerId: args.customerId,
            paymentMethod: args.paymentMethod,
            amount: args.amount,
            status: OrderStatus.CREATED,
            version: 1,
            createdAt: event.timestamp,
          },
        });
        await postLedger(tx, {
          orderId,
          eventId: event.id,
          postings: [
            entry.debit(LedgerAccount.order_balance, args.amount),
            entry.credit(LedgerAccount.order_pending, args.amount),
          ],
        });
        return { order, event, replayed: false };
      }),
  });
}

/* ------------------------------------------------------------------------ *
 * A.2 — recordPayment
 * ------------------------------------------------------------------------ */

export interface RecordPaymentArgs {
  orderId: string;
  amount: Money;
  stripeChargeId: string;
  idempotencyKey: string;
}

/**
 * PaymentConfirmed + ledger: DEBIT payment_received / CREDIT order_balance.
 * Idempotent on the key; concurrent distinct-key calls race on
 * Unique(aggregateId, version) and exactly one wins.
 */
export async function recordPayment(args: RecordPaymentArgs): Promise<MutationResult> {
  const amountStr = toMoneyString(args.amount);
  return withIdempotentEvent({
    key: args.idempotencyKey,
    intent: {
      eventType: 'PaymentConfirmed',
      aggregateId: args.orderId,
      match: { amount: amountStr, stripeChargeId: args.stripeChargeId },
    },
    replay: replayOrderResult,
    execute: () =>
      prisma.$transaction(async (tx) => {
        const order = await getOrderOrThrow(tx, args.orderId);
        assertTransition('PaymentConfirmed', order.status, order.id);
        if (!isSameAmount(order.amount, args.amount)) {
          throw new ValidationError(
            `payment amount ${amountStr} does not match order amount ${toMoneyString(order.amount)}; partial payments are not supported`,
          );
        }
        const last = await latestEvent(tx, order.id);
        const version = (last?.version ?? 0) + 1;
        const payload: payloads.PaymentConfirmedPayload = {
          orderId: order.id,
          amount: amountStr,
          stripeChargeId: args.stripeChargeId,
        };
        const event = await appendEvent(tx, {
          aggregateId: order.id,
          eventType: 'PaymentConfirmed',
          payload,
          version,
          idempotencyKey: args.idempotencyKey,
        });
        await postLedger(tx, {
          orderId: order.id,
          eventId: event.id,
          postings: [
            entry.debit(LedgerAccount.payment_received, args.amount),
            entry.credit(LedgerAccount.order_balance, args.amount),
          ],
        });
        const updated = await updateProjectionGuarded(tx, order, {
          status: OrderStatus.PAID,
          paidAt: event.timestamp,
          stripeChargeId: args.stripeChargeId,
          version,
        });
        return { order: updated, event, replayed: false };
      }),
  });
}

/* ------------------------------------------------------------------------ *
 * A.2 — calculateFees
 * ------------------------------------------------------------------------ */

export interface CalculateFeesArgs {
  orderId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface CalculateFeesResult extends MutationResult {
  feeAmount: Money;
  payoutAmount: Money;
}

/**
 * FeeCalculated + ledger: DEBIT fees_owed / CREDIT payment_received (3%).
 * The fee is rounded ONCE (half-up, 4 dp) and that figure is used on both
 * ledger legs, so rounding can never unbalance the books.
 */
export async function calculateFees(args: CalculateFeesArgs): Promise<CalculateFeesResult> {
  const amountStr = toMoneyString(args.amount);
  const feeAmount = calculateFee(args.amount);
  const payoutAmount = args.amount.minus(feeAmount);

  return withIdempotentEvent({
    key: args.idempotencyKey,
    intent: {
      eventType: 'FeeCalculated',
      aggregateId: args.orderId,
      match: { baseAmount: amountStr },
    },
    replay: async (existing) => {
      const base = await replayOrderResult(existing);
      const payload = existing.payload as unknown as payloads.FeeCalculatedPayload;
      return {
        ...base,
        feeAmount: new Decimal(payload.feeAmount),
        payoutAmount: new Decimal(payload.payoutAmount),
      };
    },
    execute: () =>
      prisma.$transaction(async (tx) => {
        const order = await getOrderOrThrow(tx, args.orderId);
        assertTransition('FeeCalculated', order.status, order.id);
        if (order.feeAmount !== null) {
          throw new InvalidTransitionError(
            `Fees were already calculated for order "${order.id}"`,
            { orderId: order.id, feeAmount: toMoneyString(order.feeAmount) },
          );
        }
        if (!isSameAmount(order.amount, args.amount)) {
          throw new ValidationError(
            `fee base ${amountStr} does not match order amount ${toMoneyString(order.amount)}`,
          );
        }
        const last = await latestEvent(tx, order.id);
        const version = (last?.version ?? 0) + 1;
        const payload: payloads.FeeCalculatedPayload = {
          orderId: order.id,
          baseAmount: amountStr,
          feeRate: FEE_RATE.toString(),
          feeAmount: toMoneyString(feeAmount),
          payoutAmount: toMoneyString(payoutAmount),
        };
        const event = await appendEvent(tx, {
          aggregateId: order.id,
          eventType: 'FeeCalculated',
          payload,
          version,
          idempotencyKey: args.idempotencyKey,
        });
        await postLedger(tx, {
          orderId: order.id,
          eventId: event.id,
          postings: [
            entry.debit(LedgerAccount.fees_owed, feeAmount),
            entry.credit(LedgerAccount.payment_received, feeAmount),
          ],
        });
        const updated = await updateProjectionGuarded(tx, order, {
          feeAmount,
          payoutAmount,
          version,
        });
        return { order: updated, event, replayed: false, feeAmount, payoutAmount };
      }),
  });
}

/* ------------------------------------------------------------------------ *
 * Payment orchestration (POST /orders/:id/pay)
 * ------------------------------------------------------------------------ */

export interface ProcessPaymentResult {
  order: OrderProjection;
  charge: stripe.StripeCharge;
  replayed: boolean;
}

/**
 * Mini-saga: intent -> charge -> confirm -> fees. Each step is idempotent on a
 * key derived from the caller's idempotencyKey, so a retry after ANY partial
 * failure (timeout, crash, Stripe 5xx) resumes exactly where it stopped:
 * completed steps replay, pending steps execute. The mock chargeId is a pure
 * function of the key, so step 2 can never charge twice for one key.
 */
export async function processOrderPayment(args: {
  orderId: string;
  idempotencyKey: string;
}): Promise<ProcessPaymentResult> {
  const order = await prisma.orderProjection.findUnique({ where: { id: args.orderId } });
  if (!order) throw new NotFoundError(`Order "${args.orderId}" not found`);

  // Step 1 — record intent (no money movement; guards double-pay attempts).
  await appendStatusEvent({
    orderId: order.id,
    eventType: 'PaymentProcessing',
    idempotencyKey: `${args.idempotencyKey}:processing`,
    buildPayload: (o): payloads.PaymentProcessingPayload => ({
      orderId: o.id,
      amount: toMoneyString(o.amount),
      customerId: o.customerId,
    }),
  });

  // Step 2 — charge the provider.
  let charge: stripe.StripeCharge;
  try {
    charge = await stripe.processPayment({
      orderId: order.id,
      amount: order.amount,
      customerId: order.customerId,
      idempotencyKey: args.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof CardDeclinedError) {
      // Terminal decline: record it, surface 402. A new attempt needs a new key.
      await appendStatusEvent({
        orderId: order.id,
        eventType: 'PaymentFailed',
        idempotencyKey: `${args.idempotencyKey}:failed`,
        buildPayload: (o): payloads.PaymentFailedPayload => ({
          orderId: o.id,
          amount: toMoneyString(o.amount),
          reason: error.reason,
        }),
      });
    }
    // Transient StripeApiError: state stays PAYMENT_PROCESSING on purpose —
    // the client must retry with the SAME key (fresh keys are rejected by the
    // state machine, because a second live attempt could double-charge).
    throw error;
  }

  // Steps 3 & 4 — confirm + fees, each idempotent in its own transaction.
  const confirmed = await recordPayment({
    orderId: order.id,
    amount: order.amount,
    stripeChargeId: charge.chargeId,
    idempotencyKey: `${args.idempotencyKey}:confirmed`,
  });
  const feeResult = await calculateFees({
    orderId: order.id,
    amount: order.amount,
    idempotencyKey: `${args.idempotencyKey}:fee`,
  });

  return { order: feeResult.order, charge, replayed: confirmed.replayed };
}

/* ------------------------------------------------------------------------ *
 * Fulfillment + refunds
 * ------------------------------------------------------------------------ */

export async function shipOrder(args: { orderId: string; idempotencyKey: string }): Promise<MutationResult> {
  return appendStatusEvent({
    orderId: args.orderId,
    eventType: 'OrderShipped',
    idempotencyKey: args.idempotencyKey,
    buildPayload: (o): payloads.OrderShippedPayload => ({ orderId: o.id }),
  });
}

export async function deliverOrder(args: { orderId: string; idempotencyKey: string }): Promise<MutationResult> {
  return appendStatusEvent({
    orderId: args.orderId,
    eventType: 'OrderDelivered',
    idempotencyKey: args.idempotencyKey,
    buildPayload: (o): payloads.OrderDeliveredPayload => ({ orderId: o.id }),
  });
}

/**
 * OrderRefunded reverses every prior posting of the order in ONE balanced set:
 * payment, fee (if any) and the original order recognition. Afterwards every
 * account nets to zero for this order. Only unsettled orders can be refunded;
 * post-settlement refunds would claw back an already-paid payout and are out
 * of scope (documented in docs/FINANCIAL_RULES.md).
 */
export async function refundOrder(args: {
  orderId: string;
  idempotencyKey: string;
  reason?: string | undefined;
}): Promise<MutationResult> {
  return withIdempotentEvent({
    key: args.idempotencyKey,
    intent: { eventType: 'OrderRefunded', aggregateId: args.orderId },
    replay: replayOrderResult,
    execute: () =>
      prisma.$transaction(async (tx) => {
        const order = await getOrderOrThrow(tx, args.orderId);
        assertTransition('OrderRefunded', order.status, order.id);
        if (order.settlementId !== null) {
          throw new InvalidTransitionError(
            `Order "${order.id}" was settled in "${order.settlementId}"; refunds after payout are not supported`,
            { orderId: order.id, settlementId: order.settlementId },
          );
        }
        const amount = order.amount;
        const fee = order.feeAmount ?? ZERO;

        const last = await latestEvent(tx, order.id);
        const version = (last?.version ?? 0) + 1;
        const payload: payloads.OrderRefundedPayload = {
          orderId: order.id,
          amount: toMoneyString(amount),
          feeAmount: toMoneyString(fee),
          reason: args.reason ?? null,
        };
        const event = await appendEvent(tx, {
          aggregateId: order.id,
          eventType: 'OrderRefunded',
          payload,
          version,
          idempotencyKey: args.idempotencyKey,
        });
        await postLedger(tx, {
          orderId: order.id,
          eventId: event.id,
          postings: [
            // reverse PaymentConfirmed
            entry.debit(LedgerAccount.order_balance, amount),
            entry.credit(LedgerAccount.payment_received, amount),
            // reverse FeeCalculated
            ...(fee.gt(ZERO)
              ? [
                  entry.debit(LedgerAccount.payment_received, fee),
                  entry.credit(LedgerAccount.fees_owed, fee),
                ]
              : []),
            // reverse OrderCreated
            entry.debit(LedgerAccount.order_pending, amount),
            entry.credit(LedgerAccount.order_balance, amount),
          ],
        });
        const updated = await updateProjectionGuarded(
          tx,
          order,
          { status: OrderStatus.REFUNDED, version },
          { settlementId: null }, // hard re-check at write time vs racing settlement
        );
        return { order: updated, event, replayed: false };
      }),
  });
}

/* ------------------------------------------------------------------------ *
 * A.2 — dailySettlement
 * ------------------------------------------------------------------------ */

export interface SettlementResult {
  settlementId: string;
  date: string;
  orderCount: number;
  totalGross: string;
  totalFees: string;
  totalPayout: string;
  /** true when this settlement had already been processed earlier. */
  alreadySettled: boolean;
}

function toSettlementResult(
  settlement: {
    id: string;
    date: string;
    orderCount: number;
    totalGross: Prisma.Decimal;
    totalFees: Prisma.Decimal;
    totalPayout: Prisma.Decimal;
  },
  alreadySettled: boolean,
): SettlementResult {
  return {
    settlementId: settlement.id,
    date: settlement.date,
    orderCount: settlement.orderCount,
    totalGross: toMoneyString(settlement.totalGross),
    totalFees: toMoneyString(settlement.totalFees),
    totalPayout: toMoneyString(settlement.totalPayout),
    alreadySettled,
  };
}

/**
 * SettlementProcessed + per-order ledger: DEBIT seller_payout / CREDIT
 * payment_received for each eligible order's net (amount − fee).
 *
 * Idempotent on the calendar DATE (the natural business key): one settlement
 * may ever exist per day, and settling the same day again — whatever the
 * idempotencyKey — returns the original result. Three unique constraints
 * (settlement.date, EventLog idempotencyKey, EventLog aggregate+version)
 * each independently prevent a duplicate under any race.
 */
export async function dailySettlement(args: {
  date: string;
  idempotencyKey?: string | undefined;
}): Promise<SettlementResult> {
  if (!isValidDateString(args.date)) {
    throw new ValidationError('date must be a valid calendar date in YYYY-MM-DD (UTC) format');
  }
  const aggregateId = settlementAggregateId(args.date);
  const idempotencyKey = args.idempotencyKey ?? aggregateId;

  const existing = await prisma.settlement.findUnique({ where: { date: args.date } });
  if (existing) return toSettlementResult(existing, true);

  try {
    return await prisma.$transaction(
      async (tx) => {
        const eligible = await tx.orderProjection.findMany({
          where: {
            status: { in: SETTLEABLE_STATUSES },
            settlementId: null,
            feeAmount: { not: null },
            paidAt: { lt: endOfUtcDay(args.date) },
          },
          orderBy: { id: 'asc' },
        });

        let totalGross = ZERO;
        let totalFees = ZERO;
        let totalPayout = ZERO;
        const lines: payloads.SettlementOrderLine[] = [];
        for (const order of eligible) {
          if (order.feeAmount === null || order.payoutAmount === null) {
            continue; // unreachable given the WHERE, but keeps types honest
          }
          totalGross = totalGross.add(order.amount);
          totalFees = totalFees.add(order.feeAmount);
          totalPayout = totalPayout.add(order.payoutAmount);
          lines.push({ orderId: order.id, payout: toMoneyString(order.payoutAmount) });
        }

        const payload: payloads.SettlementProcessedPayload = {
          date: args.date,
          orderCount: lines.length,
          totalGross: toMoneyString(totalGross),
          totalFees: toMoneyString(totalFees),
          totalPayout: toMoneyString(totalPayout),
          orders: lines,
        };
        const event = await appendEvent(tx, {
          aggregateId,
          eventType: 'SettlementProcessed',
          payload,
          version: 1,
          idempotencyKey,
        });

        // Settlement row must exist before order rows can reference it (FK).
        const settlement = await tx.settlement.create({
          data: {
            id: aggregateId,
            date: args.date,
            orderCount: lines.length,
            totalGross,
            totalFees,
            totalPayout,
          },
        });

        if (lines.length > 0) {
          const rows = eligible.flatMap((order) =>
            order.payoutAmount === null
              ? []
              : toLedgerRows({
                  orderId: order.id,
                  eventId: event.id,
                  postings: [
                    entry.debit(LedgerAccount.seller_payout, order.payoutAmount),
                    entry.credit(LedgerAccount.payment_received, order.payoutAmount),
                  ],
                }),
          );
          await tx.ledgerEntry.createMany({ data: rows });

          const updated = await tx.orderProjection.updateMany({
            where: {
              id: { in: lines.map((line) => line.orderId) },
              settlementId: null,
              status: { in: SETTLEABLE_STATUSES },
            },
            data: { settlementId: aggregateId, settledAt: event.timestamp },
          });
          if (updated.count !== lines.length) {
            // An order changed (e.g. refunded) between our read and this write.
            // Roll everything back; the caller can simply settle again.
            throw new VersionConflictError(aggregateId);
          }
        }

        return toSettlementResult(settlement, false);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (error) {
    // Lost a race against a concurrent settlement of the same date: any of the
    // three unique constraints may fire first (the aggregate+version one
    // arrives already translated to VersionConflictError by appendEvent).
    // The winner's row is committed by now — return it so both callers
    // observe the same result. If there is no winner row (e.g. the conflict
    // came from the order-update guard racing a refund), rethrow.
    const maybeLostRace =
      error instanceof VersionConflictError ||
      isUniqueViolation(error, 'settlement') ||
      isUniqueViolation(error, 'idempotency');
    if (maybeLostRace) {
      const winner = await prisma.settlement.findUnique({ where: { date: args.date } });
      if (winner) return toSettlementResult(winner, true);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------ *
 * A.2 — verifyLedgerBalance
 * ------------------------------------------------------------------------ */

export interface AccountBreakdown {
  account: LedgerAccount;
  debits: string;
  credits: string;
  /** debits − credits (signed). */
  net: string;
}

export interface LedgerVerification {
  scope: 'order' | 'global';
  orderId: string | null;
  entryCount: number;
  sumDebits: string;
  sumCredits: string;
  difference: string;
  balanced: boolean;
  accounts: AccountBreakdown[];
}

async function summarizeLedger(
  where: Prisma.LedgerEntryWhereInput,
  scope: 'order' | 'global',
  orderId: string | null,
): Promise<LedgerVerification> {
  const groups = await prisma.ledgerEntry.groupBy({
    by: ['account'],
    where,
    _sum: { debit: true, credit: true },
    _count: { _all: true },
  });

  let sumDebits = ZERO;
  let sumCredits = ZERO;
  let entryCount = 0;
  const accounts: AccountBreakdown[] = groups
    .map((group) => {
      const debits = group._sum.debit ?? ZERO;
      const credits = group._sum.credit ?? ZERO;
      sumDebits = sumDebits.add(debits);
      sumCredits = sumCredits.add(credits);
      entryCount += group._count._all;
      return {
        account: group.account,
        debits: toMoneyString(debits),
        credits: toMoneyString(credits),
        net: toMoneyString(debits.minus(credits)),
      };
    })
    .sort((a, b) => a.account.localeCompare(b.account));

  const difference = sumDebits.minus(sumCredits);
  return {
    scope,
    orderId,
    entryCount,
    sumDebits: toMoneyString(sumDebits),
    sumCredits: toMoneyString(sumCredits),
    difference: toMoneyString(difference),
    balanced: difference.isZero(),
    accounts,
  };
}

/** Per-order invariant: sum(debits) − sum(credits) MUST equal 0. */
export async function verifyLedgerBalance(orderId: string): Promise<LedgerVerification> {
  const order = await prisma.orderProjection.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError(`Order "${orderId}" not found`);
  return summarizeLedger({ orderId }, 'order', orderId);
}

/** Whole-system trial balance: the same invariant over every ledger row. */
export async function trialBalance(): Promise<LedgerVerification> {
  return summarizeLedger({}, 'global', null);
}
