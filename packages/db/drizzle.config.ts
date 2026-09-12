import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation runs as the schema owner (`DATABASE_ADMIN_URL`), never as
 * the RLS-constrained application role.
 */
const url = process.env.DATABASE_ADMIN_URL;
if (!url) {
  throw new Error('DATABASE_ADMIN_URL must be set to generate or introspect migrations');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url },
  casing: 'snake_case',
  strict: true,
  verbose: true,
});
