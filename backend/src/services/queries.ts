import { EventLog, LedgerEntry, OrderProjection, OrderStatus, Settlement } from '@prisma/client';
import { NotFoundError } from '../lib/errors';
import { Money, toMoneyString, ZERO } from '../lib/money';
import { prisma } from '../lib/prisma';

/** Read-side queries for the API. All of this is served from projections. */

export async function getOrderWithEvents(
  orderId: string,
): Promise<{ order: OrderProjection; events: EventLog[] }> {
  const order = await prisma.orderProjection.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError(`Order "${orderId}" not found`);
  const events = await prisma.eventLog.findMany({
    where: { aggregateId: orderId },
    orderBy: { version: 'asc' },
  });
  return { order, events };
}

export interface OrderListResult {
  orders: OrderProjection[];
  nextCursor: string | null;
}

export async function listOrders(args: {
  limit?: number | undefined;
  cursor?: string | undefined;
  status?: OrderStatus | undefined;
}): Promise<OrderListResult> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const orders = await prisma.orderProjection.findMany({
    where: args.status ? { status: args.status } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
  });
  const hasMore = orders.length > limit;
  const page = hasMore ? orders.slice(0, limit) : orders;
  const lastOrder = page[page.length - 1];
  return { orders: page, nextCursor: hasMore && lastOrder ? lastOrder.id : null };
}

export type LedgerEntryWithEvent = LedgerEntry & {
  event: Pick<EventLog, 'eventType' | 'version'>;
  /** Signed cumulative (debits − credits) over the order's entries so far. */
  runningBalance: Money;
};

export interface OrderLedgerResult {
  order: OrderProjection;
  entries: LedgerEntryWithEvent[];
}

export async function getOrderLedger(orderId: string): Promise<OrderLedgerResult> {
  const order = await prisma.orderProjection.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError(`Order "${orderId}" not found`);
  const rows = await prisma.ledgerEntry.findMany({
    where: { orderId },
    orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
    include: { event: { select: { eventType: true, version: true } } },
  });
  let running = ZERO;
  const entries = rows.map((row) => {
    running = running.add(row.debit ?? ZERO).minus(row.credit ?? ZERO);
    return { ...row, runningBalance: running };
  });
  return { order, entries };
}

export async function listSettlements(): Promise<Settlement[]> {
  return prisma.settlement.findMany({ orderBy: { date: 'desc' } });
}

export interface DashboardSummary {
  totalOrders: number;
  byStatus: Record<string, number>;
  paidGross: string;
  totalFees: string;
  unsettledPayout: string;
  settledPayout: string;
  lastSettlementDate: string | null;
}

const PAID_LIKE: OrderStatus[] = [OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.DELIVERED];

export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [byStatusGroups, paidAggregate, unsettledAggregate, settledAggregate, lastSettlement] =
    await Promise.all([
      prisma.orderProjection.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.orderProjection.aggregate({
        where: { status: { in: PAID_LIKE } },
        _sum: { amount: true, feeAmount: true },
      }),
      prisma.orderProjection.aggregate({
        where: { status: { in: PAID_LIKE }, settlementId: null },
        _sum: { payoutAmount: true },
      }),
      prisma.orderProjection.aggregate({
        where: { settlementId: { not: null } },
        _sum: { payoutAmount: true },
      }),
      prisma.settlement.findFirst({ orderBy: { date: 'desc' } }),
    ]);

  const byStatus: Record<string, number> = {};
  let totalOrders = 0;
  for (const group of byStatusGroups) {
    byStatus[group.status] = group._count._all;
    totalOrders += group._count._all;
  }

  return {
    totalOrders,
    byStatus,
    paidGross: toMoneyString(paidAggregate._sum.amount ?? ZERO),
    totalFees: toMoneyString(paidAggregate._sum.feeAmount ?? ZERO),
    unsettledPayout: toMoneyString(unsettledAggregate._sum.payoutAmount ?? ZERO),
    settledPayout: toMoneyString(settledAggregate._sum.payoutAmount ?? ZERO),
    lastSettlementDate: lastSettlement?.date ?? null,
  };
}
