# Part D: Code Review

Here's the `recordPayment` we were asked to review (reformatted, otherwise as given):

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

I read it as "charge the card, then remember we did it." For code that moves real money that is a
lot of trust to put in a happy path that won't always happen. I went through it line by line. Below
are the problems, starting with the ones that actually cost money.

## The ones that lose money

**1. Two requests can charge the same card twice.**
The guard on line 2 reads `payment_received`, but the charge on line 13 happens a few `await`s later
and nothing holds a lock in between. So two requests that arrive close together (a double-click, a
retry racing the original, two instances behind a load balancer) both read `0`, both pass the
check, and both call `stripeAPI.charge`. The customer pays twice. This is a check-then-act (TOCTOU)
race, and you can't close it with an `if` in memory. The database has to be the thing that decides
only one of them wins. In my version that job is done by a unique constraint on
`(aggregateId, version)`.

**2. It charges before it writes anything down.**
`stripeAPI.charge` runs before any event exists. If the process dies right after the charge (a
crash, out-of-memory, a deploy restart), the money already left the customer's card and nothing
recorded that it happened. For a system whose whole job is to never lose track of money, that is the
worst case. The order should be: record that we are about to pay, charge, then record that we paid.
Each of those steps also has to be safe to run a second time.

**3. Stripe never gets an idempotency key.**
Even if our own database stops duplicate events later, the charge itself is unprotected. If the
network drops between `charge()` and `create()`, the retry calls `charge()` again, and nothing tells
Stripe that this is the same payment as before. That's a second charge. The real Stripe API takes an
`Idempotency-Key` header for this exact situation, and it should come from the key we already have.
(In my implementation the mock's `chargeId` is just a hash of that key, so the same key cannot
produce two charges.)

## The ones that corrupt the books

**4. It never writes to the ledger.**
The task is built around double-entry bookkeeping, and this function records a payment by writing a
number into a column. No debit, no credit. That leaves `verifyLedgerBalance` with nothing to check
and no audit trail at all. The `payment_received` value becomes a number you just have to trust. A
payment should append a balanced debit/credit pair (here: debit `payment_received`, credit
`order_balance`) in the same transaction as the event.

**5. The event and the order update are two separate writes.**
`financialEvent.create` and `order.update` aren't wrapped in a transaction. If it crashes between
them, you get a "PaymentConfirmed" event sitting next to an order row that still says unpaid.
Everything that belongs to one payment (the event, the ledger rows, the read model) needs to commit
together or not at all.

**6. The version comes from a stale read.**
`order.version + 1` uses the row fetched back on line 1. By the time we insert, someone else may
already have taken that version number. With no unique constraint you end up with two events at the
same version and the stream can't be replayed. Add the constraint but forget to handle its error,
and the request blows up with a 500 after the card was already charged. The fix is to read the
current version inside the transaction, insert N+1, and turn the unique-violation into a clean `409`
the caller can understand.

**7. The amount is a float.**
`amount` arrives as a plain JS number and goes straight into the payload and the column. `0.1 + 0.2`
isn't `0.3`, cents drift over time, and once the number is serialized into JSON it stays a float.
The function also never compares `amount` to what the order actually costs, so it will charge an
overpayment, an underpayment, or a negative number without complaint. Money should travel as a
decimal string and live in the database as `Decimal(18,4)`.

## Smaller, but still wrong

**8. `payment_received > 0` is pretending to be a state machine.**
Using a number as state lets through things that should be impossible. A refund might set the column
back to `0`, which makes a refunded order look payable again. You can also "pay" an order that was
never finished being created. There is no explicit status and no list of allowed moves. Payment
should only be allowed from a real state such as `CREATED` or `PAYMENT_PROCESSING`.

**9. The idempotent replay is in the wrong spot and incomplete.**
Two problems. First, the `existing` lookup sits after the "already paid" check, so a genuine retry
of a payment that already went through hits `throw new Error('Already paid')` and gets an error
instead of its own result. The key lookup needs to run first. Second, even when it does return
`existing`, that is only correct if the original call actually finished. If the first attempt died
after `create()` but before `order.update()`, the retry returns the event and the order is never
updated. A safe replay has to hand back the result of a completed operation, and it should reject the
same key used with a different amount instead of quietly returning the old one.

**10. No null check, no error types, and it overwrites instead of appends.**
If `orderId` is wrong, `order` is `null` and `order.payment_received` throws a TypeError 500 where a
404 would be the honest answer. A declined card and a temporary Stripe outage come back looking
identical, so the caller can't tell whether retrying is safe. And `data: { payment_received: amount }`
overwrites the column, so a second buggy call silently wipes the first value. In an append-only
system you add an event and derive the number from it, you don't overwrite it.

## What I did instead

The version I shipped is [`recordPayment`](../backend/src/services/financial-service.ts) and the
[`processOrderPayment`](../backend/src/services/financial-service.ts) wrapper around it. In short,
how it avoids the problems above:

- It looks up the idempotency key first, and if the key was reused with a different amount it returns
  `422` instead of the wrong result.
- The event, the ledger pair, and the projection update all happen in one transaction. It reads the
  latest version inside that transaction, inserts N+1, and lets the unique constraints on the key and
  on `(aggregateId, version)` be the real gate. A lost race comes back as `409`.
- The Stripe call sits outside the database transaction but inside the saga: a `PaymentProcessing`
  event before it, `PaymentConfirmed` plus fees after it, and a key derived per step, so a retry
  picks up where it left off instead of charging again.
- A decline is recorded as `PaymentFailed` and returns `402`. A transient Stripe error returns `502`,
  and resuming with the same key is safe.

Each of these has a test in `backend/tests/` that fails if I take the protection back out.
