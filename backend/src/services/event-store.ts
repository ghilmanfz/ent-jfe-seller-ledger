import { EventLog, EventType, Prisma } from '@prisma/client';
import { IdempotencyConflictError, VersionConflictError } from '../lib/errors';
import { prisma, Tx } from '../lib/prisma';

/**
 * Append-only event store on top of two unique constraints:
 *
 *   Unique(aggregateId, version)  -> optimistic concurrency control. Writers
 *     read the current version, then INSERT version+1. Two concurrent writers
 *     compute the same next version; Postgres lets exactly one INSERT through
 *     and the loser gets a VersionConflictError. No row locks, no deadlocks.
 *
 *   Unique(idempotencyKey)        -> retry safety. A retried mutation can only
 *     ever find the original event; it can never append a second one.
 *
 * Immutability is enforced in the database itself: BEFORE UPDATE/DELETE
 * triggers on event_log and ledger_entry raise an exception (see migration).
 */

export interface AppendEventArgs {
  aggregateId: string;
  eventType: EventType;
  /** JSON-safe object; monetary values must already be 4-dp strings. */
  payload: object;
  version: number;
  idempotencyKey: string;
}

export async function appendEvent(tx: Tx, args: AppendEventArgs): Promise<EventLog> {
  try {
    return await tx.eventLog.create({
      data: {
        aggregateId: args.aggregateId,
        eventType: args.eventType,
        payload: args.payload as Prisma.InputJsonObject,
        version: args.version,
        idempotencyKey: args.idempotencyKey,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error, 'aggregate')) {
      throw new VersionConflictError(args.aggregateId, args.version);
    }
    // idempotencyKey violations bubble up to withIdempotentEvent, which
    // resolves them into a replay of the stored event.
    throw error;
  }
}

export async function latestEvent(tx: Tx, aggregateId: string): Promise<EventLog | null> {
  return tx.eventLog.findFirst({
    where: { aggregateId },
    orderBy: { version: 'desc' },
  });
}

export async function findEventByKey(idempotencyKey: string): Promise<EventLog | null> {
  return prisma.eventLog.findUnique({ where: { idempotencyKey } });
}

/** Did this error come from a P2002 unique violation on a matching constraint? */
export function isUniqueViolation(error: unknown, constraintHint: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  // Depending on Prisma version/connector, meta.target is a field list or a
  // constraint name; normalising to a lowercase string covers both.
  const target = JSON.stringify(error.meta?.target ?? '').toLowerCase();
  return target.includes(constraintHint.toLowerCase());
}

export interface IdempotencyIntent {
  eventType: EventType;
  /** Expected aggregate, when the caller already knows it (replay must match). */
  aggregateId?: string | undefined;
  /** Payload fields that must be identical for the same key (e.g. amount). */
  match?: Record<string, string | undefined>;
}

/**
 * Reusing a key with different parameters is always a client bug; silently
 * returning the stored (different!) result would hide real money mistakes.
 */
export function assertSameIntent(existing: EventLog, key: string, intent: IdempotencyIntent): void {
  const mismatches: Record<string, { stored: unknown; requested: unknown }> = {};
  if (existing.eventType !== intent.eventType) {
    mismatches['eventType'] = { stored: existing.eventType, requested: intent.eventType };
  }
  if (intent.aggregateId !== undefined && existing.aggregateId !== intent.aggregateId) {
    mismatches['aggregateId'] = { stored: existing.aggregateId, requested: intent.aggregateId };
  }
  const payload = existing.payload as Record<string, unknown>;
  for (const [field, requested] of Object.entries(intent.match ?? {})) {
    if (requested !== undefined && payload[field] !== requested) {
      mismatches[field] = { stored: payload[field], requested };
    }
  }
  if (Object.keys(mismatches).length > 0) {
    throw new IdempotencyConflictError(key, { mismatches });
  }
}

/**
 * Standard shape of every idempotent mutation:
 *  1. If an event with this key exists, validate the intent matches and replay
 *     the stored outcome (same result, zero side effects).
 *  2. Otherwise run the real transaction.
 *  3. If the transaction fails AND an event with this key exists afterwards,
 *     a concurrent request carrying the same key won the race — whatever error
 *     we hit on the way (unique violation on the key itself, or a state-machine
 *     rejection because the winner already advanced the aggregate). The winner
 *     is committed by then, so replaying it gives both callers the same result
 *     and exactly one event exists. If no event with our key exists, the error
 *     was real — rethrow it.
 */
export async function withIdempotentEvent<T>(opts: {
  key: string;
  intent: IdempotencyIntent;
  execute: () => Promise<T>;
  replay: (existing: EventLog) => Promise<T>;
}): Promise<T> {
  const { key, intent, execute, replay } = opts;

  const existing = await findEventByKey(key);
  if (existing) {
    assertSameIntent(existing, key, intent);
    return replay(existing);
  }

  try {
    return await execute();
  } catch (error) {
    if (error instanceof IdempotencyConflictError) throw error;
    const winner = await findEventByKey(key);
    if (winner) {
      assertSameIntent(winner, key, intent);
      return replay(winner);
    }
    throw error;
  }
}
