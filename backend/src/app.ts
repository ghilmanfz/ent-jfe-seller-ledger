import cors from '@fastify/cors';
import fastify, { FastifyInstance } from 'fastify';
import { config } from './config';
import { errorHandler } from './plugins/error-handler';
import { ordersRoutes } from './routes/orders';
import { settlementRoutes } from './routes/settlement';
import { summaryRoutes } from './routes/summary';
import { verifyRoutes } from './routes/verify';

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    logger: config.isTest ? false : { level: 'info' },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method} ${request.url} not found`,
      },
    });
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'ent-jfe-backend',
    timestamp: new Date().toISOString(),
  }));

  await app.register(ordersRoutes);
  await app.register(settlementRoutes);
  await app.register(verifyRoutes);
  await app.register(summaryRoutes);

  return app;
}
