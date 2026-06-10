import { config } from 'dotenv';
import path from 'node:path';

// Loaded via jest `setupFiles`, i.e. before any test module (and before any
// PrismaClient) is constructed. `override` beats a previously loaded .env.
config({ path: path.join(__dirname, '..', '.env.test'), override: true });

if (!process.env['DATABASE_URL']?.includes('_test')) {
  // Tests TRUNCATE every table — refuse to run against anything but *_test.
  throw new Error('Refusing to run tests: DATABASE_URL does not point at a *_test database');
}
