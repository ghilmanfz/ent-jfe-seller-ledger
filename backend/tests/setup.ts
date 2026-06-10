import { prisma } from '../src/lib/prisma';

beforeEach(async () => {
  // TRUNCATE bypasses the append-only row triggers (statement-level reset for
  // tests only); CASCADE clears FK references in one shot.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ledger_entry", "event_log", "order_projection", "settlement" CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});
