import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../lib/errors';
import * as financial from '../services/financial-service';
import * as queries from '../services/queries';
import { settlementToJson } from './serializers';

const settleBody = z.object({
  date: z.string({ required_error: 'date is required (YYYY-MM-DD, UTC)' }),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  // POST /settle — run (or replay) the daily settlement for a UTC date
  app.post('/settle', async (request, reply) => {
    const parsed = settleBody.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid settlement request', parsed.error.issues);
    }
    const result = await financial.dailySettlement({
      date: parsed.data.date,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return reply.code(result.alreadySettled ? 200 : 201).send(result);
  });

  // GET /settlements — settlement history (most recent first)
  app.get('/settlements', async () => {
    const settlements = await queries.listSettlements();
    return { settlements: settlements.map(settlementToJson) };
  });
}
