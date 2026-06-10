import { buildApp } from './app';
import { config } from './config';
import { prisma } from './lib/prisma';

async function main(): Promise<void> {
  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', error);
  process.exit(1);
});
