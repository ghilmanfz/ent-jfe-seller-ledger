# Part D — Code Review

The snippet under review (reformatted, otherwise verbatim):

```js
async recordPayment(orderId, amount, idempotencyKey) {
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (order.payment_received > 0) throw new Error('Already paid');

  const existing = await db.financialEvent.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const payment = await stripeAPI.charge(amount);

  const event = await db.financialEvent.create({
    data: {
      aggregateId: orderId,
      eventType: 'PaymentConfirmed',
      payload: { amount, chargeId: payment.id },
      idempotencyKey,
      version: order.version + 1,
    },
  });

  await db.order.update({ where: { id: orderId }, data: { payment_received: amount } });
  return event;
}
```

## Findings

### 1. 🔴 TOCTOU race → double charge (race condition)

The "already paid" check reads `payment_received` at time T₀, but the charge and the write happen
much later, with `await`s in between and **no transaction or version guard anywhere**. Two
concurrent calls (double-click, two pods, a retry racing the original) both read
`payment_received = 0`, both pass the check, **both call `stripeAPI.charge`** — the customer pays
twice. The check-then-act must be made atomic; a unique constraint on
`(aggregateId, version)` (or equivalently a guarded conditional write) is the fix, not the
in-memory `if`.

### 2. 🔴 Charge happens before any durable record (money moves, no evidence)

`stripeAPI.charge` runs **before** the event is persisted. If the process crashes, the DB write
fails, or the pod is OOM-killed right after the charge, money moved and the system has **zero
record of it** — the exact failure an event-sourced payment system exists to prevent. Record
intent first (a `PaymentProcessing` event), then charge, then confirm. Every step must be
idempotent so a retry completes the half-done flow instead of repeating it.

### 3. 🔴 No idempotency key passed to Stripe (idempotency bug, provider side)

Even when our own DB dedupes the event, the **charge itself** isn't deduplicated: a network
timeout between `charge()` and `create()` leads to a retry that calls `charge()` again with no
idempotency key — second charge, first one orphaned. Stripe accepts an `Idempotency-Key` for
precisely this; it must be derived from ours (in this codebase the mock's `chargeId` is a pure
function of the key, making a duplicate charge structurally impossible).

### 4. 🔴 No ledger postings at all (ledger imbalance)

The function mutates a cached `payment_received` column and writes **no debit/credit rows**.
There is no `DEBIT payment_received / CREDIT order_balance` pair, so the books don't record the
movement: `verifyLedgerBalance` can't pass, audits have nothing to audit, and the "balance" is
just an unverifiable integer. Every financial event must append a balanced posting set **in the
same transaction as the event**.

### 5. 🔴 Event and order update are separate writes (atomicity / consistency)

`financialEvent.create` and `order.update` are two independent statements. A crash between them
leaves a confirmed-payment event with a read model that still says unpaid (or, with finding 2,
any other combination). All writes belonging to one event — event row, postings, projection —
must commit or roll back **together**.

### 6. 🟠 Version computed from a stale read, with no uniqueness to back it (lost update)

`version: order.version + 1` uses the `order` row fetched at the top — by write time another
event may have taken that version. Without `UNIQUE(aggregateId, version)` two events get the
**same version** (stream corrupted, replay ambiguous); with the constraint but no error handling
the request dies as an unhandled 500 *after the customer was charged* (finding 2 compounds it).
Correct: read the latest event version inside the transaction, insert N+1, and translate the
unique violation into an explicit `409 VERSION_CONFLICT`.

### 7. 🟠 Idempotent replay returns the event but skips the side effects (idempotency bug, local side)

The `existing` early-return happens **after** money checks but is also subtly wrong on its own:
if the first attempt crashed after `create()` but before `order.update()` (finding 5), the retry
returns `existing` immediately and the order row is **never** updated. A correct replay must
return the stored *outcome* of a *completed* operation — which is only possible when the
operation is atomic (finding 5) and the replay validates the request matches the stored payload
(same key + different amount must be `422`, not a silent wrong answer).

Ordering is also broken: a legitimate retry of the request that *did* pay the order hits
`'Already paid'` (line 2) before the idempotency lookup (line 3) and gets an **error instead of
its own result**. The key lookup must come first.

### 8. 🟠 `payment_received > 0` is not a state machine (state machine violation)

A numeric column as implicit state accepts nonsense: paying a `CANCELLED`/`REFUNDED` order
(refund could set the column back to 0 — making the order *payable again*), paying before
creation completes, etc. There is no explicit status, no allowed-transition table, no terminal
states. Payment must be validated against an explicit state machine
(`PaymentConfirmed` allowed from `CREATED`/`PAYMENT_PROCESSING` only).

### 9. 🟠 `amount` as a float, compared and stored raw (precision error)

`amount` arrives as a JS `number` and goes straight into the payload and the column:
`0.1 + 0.2 !== 0.3`, `1000.45 * 100` ≠ integer cents, JSON serialization of the payload stores a
float forever. Comparisons like `> 0` and equality checks on floats are unreliable. Money must be
a decimal string on the wire, `Decimal(18,4)` in storage, and exact-decimal arithmetic in between.
The function also never validates `amount` against the order's amount — it charges and records
**whatever the caller sent** (overpay/underpay/negative all accepted).

### 10. 🟡 No error typing, no null check, mutable overwrite

`order` may be `null` → `order.payment_received` throws a `TypeError` 500 instead of a 404.
`stripeAPI.charge` failures (declines vs transient outages) are undifferentiated, so clients
can't know whether retrying is safe. And `data: { payment_received: amount }` **overwrites**
rather than records — a second (buggy) write silently erases the first; immutable systems append
events and derive state.

## Corrected shape

The fixed version is this repository's
[`recordPayment`](../backend/src/services/financial-service.ts) plus the saga wrapper
[`processOrderPayment`](../backend/src/services/financial-service.ts):

1. idempotency lookup **first**, with intent matching (`422` on parameter mismatch);
2. inside **one transaction**: load order (404 if missing) → state machine check → amount must
   equal the order's amount → read latest version → `INSERT` event at `N+1` (unique constraints
   on key and version as the real gate) → balanced postings → guarded projection update;
3. the charge happens *outside* the DB transaction but *inside* the saga: intent event before it,
   confirmation after it, an idempotency key derived per step, and a deterministic provider key —
   so any retry resumes instead of repeating;
4. unique-violation → `409 VERSION_CONFLICT`; decline → recorded `PaymentFailed` + `402`;
   transient provider error → `502` and the same key resumes.

Every finding above maps to a test in `backend/tests/` that fails if the protection is removed.
