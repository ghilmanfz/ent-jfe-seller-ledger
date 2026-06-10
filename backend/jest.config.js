/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // env.ts loads .env.test BEFORE any module can construct a PrismaClient.
  setupFiles: ['<rootDir>/tests/env.ts'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  // Tests share one database; run files sequentially so TRUNCATE-based
  // isolation never races across files. Concurrency *inside* a test
  // (Promise.all over service calls) is unaffected.
  maxWorkers: 1,
  testTimeout: 60000,
  clearMocks: true,
};
