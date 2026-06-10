import { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { key } from './helpers';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

interface ErrorBody {
  error: { code: string; message: string };
}

async function createViaApi(overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/orders',
    payload: {
      customerId: 'cus_api',
      paymentMethod: 'card',
      amount: '100.00',
      idempotencyKey: key('api-create'),
      ...overrides,
    },
  });
}

describe('HTTP API', () => {
  it('POST /orders: 201 with Decimal-string amounts; replay returns 200 with the same order', async () => {
    const idempotencyKey = key();
    const first = await createViaApi({ idempotencyKey });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { order: { id: string; amount: string }; replayed: boolean };
    expect(firstBody.order.amount).toBe('100.0000');
    expect(typeof firstBody.order.amount).toBe('string');
    expect(firstBody.replayed).toBe(false);

    const second = await createViaApi({ idempotencyKey });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { order: { id: string }; replayed: boolean };
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.order.id).toBe(firstBody.order.id);
  });

  it('POST /orders accepts the Idempotency-Key header as an alternative to the body field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: { 'idempotency-key': key('hdr') },
      payload: { customerId: 'cus_hdr', paymentMethod: 'card', amount: '10.00' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('rejects mutations without an idempotencyKey, and malformed amounts', async () => {
    const missingKey = await createViaApi({ idempotencyKey: undefined });
    expect(missingKey.statusCode).toBe(400);
    expect((missingKey.json() as ErrorBody).error.code).toBe('VALIDATION_ERROR');

    for (const amount of [100, '10.12345', '-5.00', '1e3', '0.001']) {
      const response = await createViaApi({ amount });
      expect(response.statusCode).toBe(400);
      expect((response.json() as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('POST /orders/:id/pay runs the saga; the ledger endpoint shows balanced books and a zero running balance', async () => {
    const created = await createViaApi();
    const orderId = (created.json() as { order: { id: string } }).order.id;

    const paid = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/pay`,
      payload: { idempotencyKey: key('pay') },
    });
    expect(paid.statusCode).toBe(201);
    const paidBody = paid.json() as {
      order: { status: string; feeAmount: string; payoutAmount: string };
      payment: { chargeId: string };
    };
    expect(paidBody.order.status).toBe('PAID');
    expect(paidBody.order.feeAmount).toBe('3.0000');
    expect(paidBody.order.payoutAmount).toBe('97.0000');
    expect(paidBody.payment.chargeId).toMatch(/^ch_/);

    const ledger = await app.inject({ method: 'GET', url: `/orders/${orderId}/ledger` });
    expect(ledger.statusCode).toBe(200);
    const ledgerBody = ledger.json() as {
      entries: Array<{ runningBalance: string; debit: string | null; credit: string | null }>;
      totals: { balanced: boolean; sumDebits: string; sumCredits: string };
    };
    expect(ledgerBody.totals.balanced).toBe(true);
    expect(ledgerBody.totals.sumDebits).toBe('203.0000');
    expect(ledgerBody.totals.sumCredits).toBe('203.0000');
    expect(ledgerBody.entries).toHaveLength(6);
    expect(ledgerBody.entries[ledgerBody.entries.length - 1]?.runningBalance).toBe('0.0000');

    const verify = await app.inject({ method: 'GET', url: `/verify-ledger/${orderId}` });
    expect((verify.json() as { balanced: boolean }).balanced).toBe(true);
  });

  it('maps domain failures onto proper HTTP codes: 402 decline, 409 double-pay, 404 unknown', async () => {
    const declined = await createViaApi({ customerId: 'cus_api_declined' });
    const declinedId = (declined.json() as { order: { id: string } }).order.id;
    const declineResponse = await app.inject({
      method: 'POST',
      url: `/orders/${declinedId}/pay`,
      payload: { idempotencyKey: key() },
    });
    expect(declineResponse.statusCode).toBe(402);
    expect((declineResponse.json() as ErrorBody).error.code).toBe('CARD_DECLINED');

    const created = await createViaApi();
    const orderId = (created.json() as { order: { id: string } }).order.id;
    await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/pay`,
      payload: { idempotencyKey: key() },
    });
    const doublePay = await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/pay`,
      payload: { idempotencyKey: key() },
    });
    expect(doublePay.statusCode).toBe(409);
    expect((doublePay.json() as ErrorBody).error.code).toBe('INVALID_TRANSITION');

    const missing = await app.inject({ method: 'GET', url: '/orders/ord_nope' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as ErrorBody).error.code).toBe('NOT_FOUND');

    const missingRoute = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(missingRoute.statusCode).toBe(404);
    expect((missingRoute.json() as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('POST /settle is idempotent at the HTTP layer; /trial-balance and /summary report sane numbers', async () => {
    const created = await createViaApi({ amount: '200.00' });
    const orderId = (created.json() as { order: { id: string } }).order.id;
    await app.inject({
      method: 'POST',
      url: `/orders/${orderId}/pay`,
      payload: { idempotencyKey: key() },
    });

    const date = new Date().toISOString().slice(0, 10);
    const first = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: { date, idempotencyKey: key('settle') },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { totalPayout: string; alreadySettled: boolean };
    expect(firstBody.alreadySettled).toBe(false);

    const second = await app.inject({
      method: 'POST',
      url: '/settle',
      payload: { date, idempotencyKey: key('settle') },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { totalPayout: string; alreadySettled: boolean };
    expect(secondBody.alreadySettled).toBe(true);
    expect(secondBody.totalPayout).toBe(firstBody.totalPayout);

    const missingDate = await app.inject({ method: 'POST', url: '/settle', payload: {} });
    expect(missingDate.statusCode).toBe(400);

    const trial = await app.inject({ method: 'GET', url: '/trial-balance' });
    expect((trial.json() as { balanced: boolean }).balanced).toBe(true);

    const summary = await app.inject({ method: 'GET', url: '/summary' });
    expect(summary.statusCode).toBe(200);
    const summaryBody = summary.json() as { totalOrders: number; settledPayout: string };
    expect(summaryBody.totalOrders).toBeGreaterThanOrEqual(1);
    expect(summaryBody.settledPayout).toBe('194.0000'); // 200 − 3% = 194
  });
});
