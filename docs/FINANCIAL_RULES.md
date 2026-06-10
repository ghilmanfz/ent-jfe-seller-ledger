# Financial Rules

The contract every line of money-touching code obeys. If code and this document disagree, it's a
bug in the code.

## Money representation

- **Storage:** PostgreSQL `DECIMAL(18,4)` — exact, 4 decimal places, 14 integer digits.
- **Computation:** `Prisma.Decimal` (decimal.js). JavaScript `number` never carries money.
- **Wire/JSON:** decimal **strings**. Inputs must match `^\d{1,14}(\.\d{1,4})?$` (positive, ≤4 dp,
  no signs/exponents/commas); responses are normalized to fixed 4 dp (`"100.0000"`). Event
  payloads store amounts as strings for the same reason — JSON numbers are floats.
- **Limits:** order amounts `0.01 ≤ x ≤ 99,999,999,999.9999` USD. The minimum keeps the 3% fee
  strictly positive (ledger rows must be > 0); the maximum is a business cap inside the column's
  range. Single currency (USD) by scope.

## Chart of accounts

| Account | Meaning | Normal balance |
| --- | --- | --- |
| `order_balance` | What the customer owes on an order; opens at creation, clears at payment | debit, transient → 0 |
| `order_pending` | Recognized order value (the "sales" side of creation) | credit |
| `payment_received` | Funds captured from the provider, not yet swept | debit, transient → 0 after settlement |
| `fees_owed` | Platform's 3% | debit |
| `seller_payout` | What the seller is owed/paid at settlement | debit |

(The brief's task A.1 lists four buckets; task A.2's posting rules name these five concrete
accounts, which the implementation follows exactly.)

## Posting rules

Every financial event writes one **balanced set** in the same transaction as the event:

| Event | Postings |
| --- | --- |
| OrderCreated | Dr `order_balance` amount · Cr `order_pending` amount |
| PaymentConfirmed | Dr `payment_received` amount · Cr `order_balance` amount |
| FeeCalculated | Dr `fees_owed` fee · Cr `payment_received` fee |
| SettlementProcessed | per order: Dr `seller_payout` (amount−fee) · Cr `payment_received` (amount−fee) |
| OrderRefunded | Dr `order_balance`/Cr `payment_received` (amount) + Dr `payment_received`/Cr `fees_owed` (fee) + Dr `order_pending`/Cr `order_balance` (amount) |

`PaymentProcessing`, `PaymentFailed`, `OrderShipped`, `OrderDelivered` move **no money** — they
are state events only.

### Worked example — $100 order, full lifecycle

| Step | order_balance | order_pending | payment_received | fees_owed | seller_payout |
| --- | ---: | ---: | ---: | ---: | ---: |
| create | +100.00 | −100.00 | | | |
| pay | −100.00 | | +100.00 | | |
| fee 3% | | | −3.00 | +3.00 | |
| settle | | | −97.00 | | +97.00 |
| **net** | **0** | **−100.00** | **0** | **+3.00** | **+97.00** |

Σdebits = Σcredits = 300.00 for the order. After a refund instead of settlement, **every** account
nets to zero (asserted in `order-lifecycle.test.ts`).

## Fees & rounding

- Rate: fixed 3% (`FEE_RATE = 0.03`), recorded in each `FeeCalculated` payload alongside base,
  fee and payout — the event is self-describing even if the rate ever changes.
- **One rounding point in the whole system:** `fee = amount × 0.03`, rounded **half-up to 4 dp**
  (`money.ts#calculateFee`). The rounded figure is used for *both* ledger legs and for
  `payout = amount − fee`, so rounding can never unbalance anything.
- 2-dp inputs produce exact fees (no rounding occurs at all: `x.yz × 0.03` has ≤ 4 dp).
  4-dp inputs may round: `10.5555 × 0.03 = 0.316665 → 0.3167` (covered by tests).
- Canonical edge cases (Part C.2, all tested): `10.00 → 0.3000`, `1.00 → 0.0300`,
  `0.07 → 0.0021`, `999,999.99 → 29,999.9997 / payout 969,999.9903`.

## Refunds

- Full refunds only (partial refunds are out of scope and rejected by amount-matching).
- Allowed from `PAID`, `SHIPPED`, `DELIVERED` — only **before** settlement. A post-settlement
  refund would claw back an already-paid payout; that's a negative-balance settlement feature,
  deliberately out of scope and rejected with `409` (`ORDER_ALREADY_SETTLED` semantics).
- Mechanically: one `OrderRefunded` event posting exact reversals of every prior posting (see
  table). History is never edited — the wrong and the correction both remain visible.
- The platform fee is returned in full on refund (simplification; real PSPs often keep it —
  changing the rule = changing one posting pair).

## Settlement

- `dailySettlement(date)` settles all orders that are paid (`PAID`/`SHIPPED`/`DELIVERED`), have
  fees calculated, are not refunded, not previously settled, and were paid before the **end of
  the given UTC calendar date** — i.e. "everything still owed to the seller as of that day".
- Payout per order = `amount − fee` (= the order's net `payment_received` balance).
- **Idempotent on the date** (the natural business key): one `Settlement` row and one
  `SettlementProcessed` event (`settlement:<date>`, version 1) may ever exist per date. Settling
  again — same key, different key, or no key — returns the stored result with
  `alreadySettled: true`. Orders paid later that day after the run are simply picked up by the
  next settlement; the recorded one is immutable.
- An empty settlement (no eligible orders) is still recorded — "we settled, there was nothing"
  is audit information.

## Invariants and enforcement layers

| Invariant | App layer | Database | Tests |
| --- | --- | --- | --- |
| Exactly one of debit/credit, > 0 | `ledger.ts#validatePostings` | `CHECK` constraints | direct SQL attempts rejected |
| Posting set balances per event | refused before INSERT | (per-row checks + FK to event) | per-step + 100-order + load test |
| Events/ledger immutable | no update code paths exist | `BEFORE UPDATE/DELETE` triggers raise | raw `UPDATE`/`DELETE` rejected |
| Version dense & unique | read-then-insert N+1 | `unique(aggregateId, version)` | concurrency suite |
| One outcome per idempotencyKey | replay machinery | `unique(idempotencyKey)` | idempotency suite |
| Σdebits = Σcredits (order/global) | by construction | — | `verify-ledger`, `trial-balance`, load test |

Defense in depth on purpose: even a buggy service path, an ad-hoc SQL session, or a future
migration script cannot record unbalanced or rewritten history without the database itself
refusing.
