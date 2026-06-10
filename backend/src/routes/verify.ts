import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as financial from '../services/financial-service';

const idParam = z.object({ id: z.string().min(1) });

export async function verifyRoutes(app: FastifyInstance): Promise<void> {
  // GET /verify-ledger/:id — per-order invariant: sum(debits) − sum(credits) === 0
  app.get('/verify-ledger/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    return financial.verifyLedgerBalance(id);
  });

  // GET /trial-balance — the same invariant over the entire ledger
  app.get('/trial-balance', async () => {
    return financial.trialBalance();
  });
}
