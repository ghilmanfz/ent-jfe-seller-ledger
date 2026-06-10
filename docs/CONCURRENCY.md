# Concurrency

1,000 concurrent orders must produce zero corruption: no duplicate events, no double charges, no
unbalanced postings, no lost updates. This document explains the mechanism, every known race, and
the proof.

## Invariants under concurrency

1. Per aggregate, event versions are unique and dense — never two events with the same version.
2. One idempotencyKey ⇒ at most one event, and every caller of that key sees the same outcome.
3. Money moves at most once per logical operation (one charge, one fee, one payout per order).
4. Every committed transaction leaves Σdebits = Σcredits (per order and globally).
5. A settlement date settles at most once; refund and settlement can never both win an order.

## The mechanism: constraint-based optimistic concurrency

Writers never lock rows. Each mutation runs:

```
BEGIN
  read projection (status guard / state machine)
  read latest event version N for the aggregate
  INSERT event (aggregateId, version = N+1, idempotencyKey, payload)   ← the gate
  INSERT balanced ledger rows (FK to the event)
  UPDATE projection WHERE id = ? AND version = N (+ extra predicates)  ← belt-and-braces
COMMIT
```

Two writers that read the same `N` both try to INSERT `N+1`. Postgres' unique index
`(aggregateId, version)` admits exactly one; the other waits on the index entry until the winner
commits, then receives a unique violation, which the service maps to `409 VERSION_CONFLICT`. The
loser's whole transaction rolls back — no partial writes can survive because the event, postings
and projection update share the transaction.

### Why not the alternatives

| Approach | Why not here |
| --- | --- |
| `SELECT … FOR UPDATE` | Serializes all writers on the order row including reads we don't need; deadlock-prone when transactions touch multiple rows in different orders; still needs the unique constraint as backstop. |
| `SERIALIZABLE` isolation | Solves the same problem with retry-on-40001 — but pays serialization checks on **every** transaction; our conflicts are rare and precisely located, so a targeted constraint is cheaper and the error is more explicit. |
| Advisory locks | App-level discipline invisible to the schema; nothing protects ad-hoc writers; harder to reason about under pgbouncer. |
| Queue per aggregate | Correct but heavy: ordering infrastructure, eventual consistency, idle cost. The constraint gives the same effect for free at this scale. |

The unique constraint is also *self-defending*: even buggy future code or a manual INSERT cannot
create a duplicate version, because the database refuses it.

## Idempotency machinery

`withIdempotentEvent` wraps every mutation:

1. **Fast path** — event with this key exists → verify the request's intent (event type,
   aggregate, monetary fields) matches the stored payload; mismatch is `422 IDEMPOTENCY_CONFLICT`
   (a silent wrong-result would hide real money bugs); match → return the stored outcome.
2. **Execute** the transaction.
3. **On any failure, re-check the key.** If an event with our key now exists, a concurrent twin
   of this request won the race — Postgres guarantees the winner committed before our violation
   surfaced, so we replay it. This catches both shapes of the race: losing on the
   `idempotencyKey` unique index itself, *and* losing so late that the winner's state-machine
   effect (e.g. status already `CREATED`) rejected us first. If no event carries our key, the
   failure was real and propagates.

The 100-concurrent-creates test fires 10 duplicate keys *simultaneously with* their originals and
asserts exactly 100 events exist; the load test repeats the trick at 1,000-order scale over HTTP.

### Saga keys

`POST /orders/:id/pay` with key `K` derives `K:processing`, `K:confirmed`, `K:fee` (and
`K:failed`). Each step is independently idempotent, so a retry resumes mid-saga instead of
restarting it. The mock chargeId is `hash(K)` — the same key *cannot* produce a second charge,
mirroring real Stripe idempotency keys.

A deliberate strictness: from `PAYMENT_PROCESSING`, a **new** key may not start another attempt
(`409`) — two live attempts with different keys would race to the charge. After a transient
Stripe failure the client must retry with the *same* key (the UI stores the key per action until
success for exactly this reason). Terminal declines (`PAYMENT_FAILED`) allow a fresh key.

## Race matrix

| Race | Outcome | Guard |
| --- | --- | --- |
| Two `recordPayment`, different keys, same order | one `201`, one `409 VERSION_CONFLICT` | unique(aggregateId, version) |
| Two pay sagas, different keys | one wins; loser `409` (version conflict or invalid transition, depending on timing) — exactly one charge/fee pair posted | version gate at step 1 + state machine |
| Same key fired twice concurrently | both return the same order; one event total | unique(idempotencyKey) + post-failure replay |
| Same key, different amount | `422 IDEMPOTENCY_CONFLICT` | intent check |
| Two creates of one client-supplied orderId | one wins; one event/projection/posting pair | aggregate constraint (concurrent) / state machine (sequential) |
| Two settlements of one date | both callers receive the identical settlement | unique(settlement.date) + aggregate `settlement:<date>` v1 + winner re-read |
| Settlement vs refund of an included order | exactly one wins; loser rolls back entirely | settlement re-checks `settlementId IS NULL` count at write time; refund's guarded update re-checks under lock (Postgres re-evaluates predicates on locked rows) |
| Retry after crash mid-saga | resumes; completed steps replay | derived sub-keys + deterministic chargeId |

The first race is pinned deterministically in `concurrency.test.ts`: writer A appends version 2
and **holds its transaction open** while writer B (a real `recordPayment`) reads version 1,
inserts version 2, and parks on A's index entry; when A commits, B *must* surface
`VERSION_CONFLICT`. No sleep-and-hope.

## Connection pooling

- Local/Railway: direct connections, `connection_limit=20` (transactions are short; 100+ HTTP
  requests in flight queue on the pool harmlessly — measured p95 under load: ~0.9s including the
  mock's artificial latency).
- Supabase: runtime through the pooler (`pgbouncer=true`, transaction mode — compatible because
  the code never uses session state), migrations through the direct URL (`DIRECT_URL`).

## Reproducing the numbers

```bash
cd backend
npm test                                  # includes 100-concurrent and race tests
npm run load-test                         # 1,000 orders against http://localhost:4000
API_URL=https://<railway-app> npm run load-test   # same against production
```

Acceptance built into the script: every request 2xx, duplicates collapsed, settlement replay
identical, global trial balance and 25 random per-order balances exactly zero difference.
