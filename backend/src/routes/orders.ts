import { FastifyInstance, FastifyRequest } from 'fastify';
import { OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { ValidationError } from '../lib/errors';
import { parseOrderAmount } from '../lib/money';
import * as financial from '../services/financial-service';
import * as queries from '../services/queries';
import { eventToJson, ledgerEntryToJson, orderToJson } from './serializers';

const idempotencyKeySchema = z
  .string()
  .min(8, 'idempotencyKey must be at least 8 characters (use a UUID)')
  .max(128)
  .regex(/^[A-Za-z0-9:._-]+$/, 'idempotencyKey may contain letters, digits, ":", ".", "_", "-"');

/**
 * Every mutation requires an idempotencyKey: in the body, or as an
 * Idempotency-Key header (body wins when both are present).
 */
function requireIdempotencyKey(request: FastifyRequest, bodyKey: string | undefined): string {
  const headerKey = request.headers['idempotency-key'];
  const raw = bodyKey ?? (typeof headerKey === 'string' ? headerKey : undefined);
  if (!raw) {
    throw new ValidationError(
      'idempotencyKey is required (body field "idempotencyKey" or "Idempotency-Key" header)',
    );
  }
  return idempotencyKeySchema.parse(raw);
}

const createOrderBody = z.object({
  orderId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,64}$/, 'orderId must be 6-64 chars of letters, digits, "_", "-"')
    .optional(),
  customerId: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'customerId must contain only letters, digits, "_", "-"'),
  paymentMethod: z.enum(['card', 'bank_transfer', 'wallet']),
  amount: z.string({ required_error: 'amount is required (decimal string, e.g. "100.00")' }),
  idempotencyKey: z.string().optional(),
});

const mutationBody = z.object({ idempotencyKey: z.string().optional() });
const refundBody = mutationBody.extend({ reason: z.string().max(500).optional() });

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
  status: z.nativeEnum(OrderStatus).optional(),
});

const idParam = z.object({ id: z.string().min(1) });

export async function ordersRoutes(app: FastifyInstance): Promise<void> {
  // POST /orders — record a new order (OrderCreated + opening ledger pair)
  app.post('/orders', async (request, reply) => {
    const body = createOrderBody.parse(request.body);
    const idempotencyKey = requireIdempotencyKey(request, body.idempotencyKey);
    const amount = parseOrderAmount(body.amount);

    const result = await financial.recordOrder({
      orderId: body.orderId,
      customerId: body.customerId,
      paymentMethod: body.paymentMethod,
      amount,
      idempotencyKey,
    });
    return reply.code(result.replayed ? 200 : 201).send({
      order: orderToJson(result.order),
      event: eventToJson(result.event),
      replayed: result.replayed,
    });
  });

  // POST /orders/:id/pay — full payment saga (processing -> charge -> confirmed -> fees)
  app.post('/orders/:id/pay', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = mutationBody.parse(request.body ?? {});
    const idempotencyKey = requireIdempotencyKey(request, body.idempotencyKey);

    const result = await financial.processOrderPayment({ orderId: id, idempotencyKey });
    return reply.code(result.replayed ? 200 : 201).send({
      order: orderToJson(result.order),
      payment: result.charge,
      replayed: result.replayed,
    });
  });

  app.post('/orders/:id/ship', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = mutationBody.parse(request.body ?? {});
    const idempotencyKey = requireIdempotencyKey(request, body.idempotencyKey);
    const result = await financial.shipOrder({ orderId: id, idempotencyKey });
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ order: orderToJson(result.order), replayed: result.replayed });
  });

  app.post('/orders/:id/deliver', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = mutationBody.parse(request.body ?? {});
    const idempotencyKey = requireIdempotencyKey(request, body.idempotencyKey);
    const result = await financial.deliverOrder({ orderId: id, idempotencyKey });
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ order: orderToJson(result.order), replayed: result.replayed });
  });

  // POST /orders/:id/refund — balanced reversal of all prior postings
  app.post('/orders/:id/refund', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = refundBody.parse(request.body ?? {});
    const idempotencyKey = requireIdempotencyKey(request, body.idempotencyKey);
    const result = await financial.refundOrder({ orderId: id, idempotencyKey, reason: body.reason });
    return reply
      .code(result.replayed ? 200 : 201)
      .send({ order: orderToJson(result.order), replayed: result.replayed });
  });

  // GET /orders — paginated list for the dashboard
  app.get('/orders', async (request) => {
    const query = listQuery.parse(request.query);
    const { orders, nextCursor } = await queries.listOrders(query);
    return { orders: orders.map(orderToJson), nextCursor };
  });

  // GET /orders/:id — projection + full event history
  app.get('/orders/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { order, events } = await queries.getOrderWithEvents(id);
    return { order: orderToJson(order), events: events.map(eventToJson) };
  });

  // GET /orders/:id/ledger — audit trail with running balance
  app.get('/orders/:id/ledger', async (request) => {
    const { id } = idParam.parse(request.params);
    const { order, entries } = await queries.getOrderLedger(id);
    const verification = await financial.verifyLedgerBalance(id);
    return {
      order: orderToJson(order),
      entries: entries.map(ledgerEntryToJson),
      totals: {
        entryCount: verification.entryCount,
        sumDebits: verification.sumDebits,
        sumCredits: verification.sumCredits,
        difference: verification.difference,
        balanced: verification.balanced,
      },
      accounts: verification.accounts,
    };
  });
}
