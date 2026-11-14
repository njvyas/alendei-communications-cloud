import { errorCode, isTransient, retryBackoffMs } from './runner-errors';

describe('Phase 8C PR 8C-3 — runner failure classification', () => {
  const pg = (code: string) => Object.assign(new Error('x'), { code });
  const wrapped = (code: string) => Object.assign(new Error('Failed query'), { cause: pg(code) });

  it('reads the SQLSTATE through the Drizzle wrapper', () => {
    expect(errorCode(wrapped('55P03'))).toBe('55P03');
    expect(errorCode(new Error('plain'))).toBeNull();
  });

  it('serialisation, deadlock, lock and statement timeouts and connection loss are transient', () => {
    for (const code of ['40001', '40P01', '55P03', '57014', '08006', 'ECONNRESET'])
      expect(isTransient(wrapped(code))).toBe(true);
    expect(isTransient(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('constraint, permission and programming errors are not transient', () => {
    for (const code of ['23505', '42501', '23514', '42P01'])
      expect(isTransient(wrapped(code))).toBe(false);
    expect(isTransient(new TypeError('boom'))).toBe(false);
  });

  it('backoff doubles from 1 s, caps at 60 s, with ±20 % jitter', () => {
    expect(retryBackoffMs(1, () => 0.5)).toBe(1000);
    expect(retryBackoffMs(2, () => 0.5)).toBe(2000);
    expect(retryBackoffMs(3, () => 0.5)).toBe(4000);
    expect(retryBackoffMs(20, () => 0.5)).toBe(60000);
    expect(retryBackoffMs(1, () => 0)).toBe(800);
    expect(retryBackoffMs(1, () => 1)).toBe(1200);
  });
});
