import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

/** The transaction client passed around inside prisma.$transaction blocks. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
