import { FastifyInstance } from 'fastify';
import * as queries from '../services/queries';

export async function summaryRoutes(app: FastifyInstance): Promise<void> {
  // GET /summary — dashboard headline numbers (orders, gross, fees, payouts)
  app.get('/summary', async () => {
    return queries.getDashboardSummary();
  });
}
