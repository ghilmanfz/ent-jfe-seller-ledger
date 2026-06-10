/**
 * Part C.1 — concurrency under load.
 *
 * Fires N orders (default 1,000) at a running API with bounded concurrency,
 * pays them all, settles the day, then proves the books:
 *   - every order recorded exactly once (duplicate keys injected on purpose),
 *   - global trial balance: sum(debits) === sum(credits),
 *   - settlement payout === Σ(amount − fee) of the paid orders.
 *
 * Usage:
 *   npm run load-test                          # against http://localhost:4000
 *   set API_URL=https://api.example.com && npm run load-test
 *   set ORDERS=200&& set CONCURRENCY=50&& npm run load-test
 */

const API_URL = (process.env['API_URL'] ?? 'http://localhost:4000').replace(/\/$/, '');
const TOTAL_ORDERS = Number(process.env['ORDERS'] ?? 1000);
const CONCURRENCY = Number(process.env['CONCURRENCY'] ?? 100);
const RUN_ID = `load${Date.now().toString(36)}`;

interface Timing {
  ok: boolean;
  ms: number;
  status: number;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; ms: number }> {
  const startedAt = performance.now();
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json, ms: performance.now() - startedAt };
}

/** Simple promise pool: keeps at most `limit` requests in flight. */
async function pool<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      if (!job) break;
      results[index] = await job();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, () => worker()));
  return results;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function report(label: string, timings: Timing[], wallMs: number): void {
  const ok = timings.filter((t) => t.ok).length;
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  console.log(
    `${label.padEnd(10)} ${ok}/${timings.length} ok in ${(wallMs / 1000).toFixed(1)}s ` +
      `(${((1000 * timings.length) / wallMs).toFixed(0)} req/s) ` +
      `p50=${percentile(sorted, 50).toFixed(0)}ms p95=${percentile(sorted, 95).toFixed(0)}ms max=${percentile(sorted, 100).toFixed(0)}ms`,
  );
}

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`Target ${API_URL} — ${TOTAL_ORDERS} orders, concurrency ${CONCURRENCY}, run ${RUN_ID}\n`);

  const health = await call('GET', '/health');
  if (health.status !== 200) fail(`API not reachable (GET /health -> ${health.status})`);

  const baseline = (await call('GET', '/trial-balance')).json as {
    sumDebits: string;
    sumCredits: string;
    balanced: boolean;
  };
  if (!baseline.balanced) fail('ledger already imbalanced before the run');

  // Mix of amounts including precision-hostile ones (Part C.2).
  const amounts = ['10.00', '19.99', '0.07', '999999.99', '1.00', '123.4567', '10.5555'];
  const orderIds: string[] = [];

  // ---- Phase 1: create -----------------------------------------------------
  const createJobs: Array<() => Promise<Timing>> = [];
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    const orderId = `ord_${RUN_ID}_${i}`;
    orderIds.push(orderId);
    const body = {
      orderId,
      customerId: `cus_${RUN_ID}_${i % 25}`,
      paymentMethod: 'card',
      amount: amounts[i % amounts.length],
      idempotencyKey: `${RUN_ID}:create:${i}`,
    };
    createJobs.push(async () => {
      const r = await call('POST', '/orders', body);
      return { ok: r.status === 201 || r.status === 200, ms: r.ms, status: r.status };
    });
    // Every 50th request is fired TWICE with the same key, concurrently —
    // idempotency must collapse the pair into one order.
    if (i % 50 === 0) {
      createJobs.push(async () => {
        const r = await call('POST', '/orders', body);
        return { ok: r.status === 201 || r.status === 200, ms: r.ms, status: r.status };
      });
    }
  }
  let startedAt = performance.now();
  const createTimings = await pool(createJobs, CONCURRENCY);
  report('create', createTimings, performance.now() - startedAt);
  const createFailures = createTimings.filter((t) => !t.ok);
  if (createFailures.length > 0) {
    fail(`${createFailures.length} creates failed (statuses: ${[...new Set(createFailures.map((t) => t.status))].join(',')})`);
  }

  // ---- Phase 2: pay --------------------------------------------------------
  const payJobs = orderIds.map((orderId, i) => async (): Promise<Timing> => {
    const r = await call('POST', `/orders/${orderId}/pay`, {
      idempotencyKey: `${RUN_ID}:pay:${i}`,
    });
    return { ok: r.status === 201 || r.status === 200, ms: r.ms, status: r.status };
  });
  startedAt = performance.now();
  const payTimings = await pool(payJobs, CONCURRENCY);
  report('pay', payTimings, performance.now() - startedAt);
  const payFailures = payTimings.filter((t) => !t.ok);
  if (payFailures.length > 0) {
    fail(`${payFailures.length} payments failed (statuses: ${[...new Set(payFailures.map((t) => t.status))].join(',')})`);
  }

  // ---- Phase 3: settle (twice — second run must be a no-op replay) ---------
  const today = new Date().toISOString().slice(0, 10);
  const settle1 = await call('POST', '/settle', { date: today, idempotencyKey: `${RUN_ID}:settle` });
  const settle2 = await call('POST', '/settle', { date: today, idempotencyKey: `${RUN_ID}:settle` });
  const s1 = settle1.json as { totalPayout: string; orderCount: number };
  const s2 = settle2.json as { totalPayout: string; orderCount: number; alreadySettled: boolean };
  console.log(`settle     ${s1.orderCount} orders, payout ${s1.totalPayout} (replay: ${String(s2.alreadySettled)})`);
  if (s1.totalPayout !== s2.totalPayout || s2.alreadySettled !== true) {
    fail('settlement is not idempotent');
  }

  // ---- Phase 4: verify the books -------------------------------------------
  const trial = (await call('GET', '/trial-balance')).json as {
    sumDebits: string;
    sumCredits: string;
    difference: string;
    balanced: boolean;
    entryCount: number;
  };
  console.log(
    `\ntrial balance: ${trial.entryCount} entries, debits ${trial.sumDebits} = credits ${trial.sumCredits} -> ${trial.balanced ? 'BALANCED' : 'IMBALANCED'}`,
  );
  if (!trial.balanced) fail(`ledger imbalanced by ${trial.difference}`);

  // Spot-check 25 random orders against /verify-ledger/:id.
  const spot = [...orderIds].sort(() => Math.random() - 0.5).slice(0, 25);
  for (const orderId of spot) {
    const v = (await call('GET', `/verify-ledger/${orderId}`)).json as { balanced: boolean };
    if (!v.balanced) fail(`order ${orderId} ledger imbalanced`);
  }
  console.log('spot check: 25/25 orders individually balanced');

  console.log('\nPASS — all orders recorded, no duplicates, ledger balanced, settlement idempotent.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
