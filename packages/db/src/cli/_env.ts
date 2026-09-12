import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * CLI entry points load `.env` from the repository root so a single file drives
 * the app, the migrations and the test harness alike.
 */
export function loadCliEnv(): void {
  loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
  loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true, override: false });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}
