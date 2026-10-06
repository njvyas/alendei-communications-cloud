/**
 * The small pools `auth-pool-isolation.sec-spec.ts` runs against, applied as a
 * side effect of being that suite's **first import**.
 *
 * Configuration is read when `AppModule` is first imported
 * (`ConfigModule.forRoot`), and the harness imports it, so setting the value in
 * `beforeAll` would be too late — the pools would silently keep the `.env`
 * size. The suite restores the previous value when it finishes, because a
 * `--runInBand` run shares one process environment across suites.
 */
export const PREVIOUS_DATABASE_POOL_MAX = process.env.DATABASE_POOL_MAX;

/** `acc_app` gets 4 connections, `acc_auth` `max(2, 4 / 2)` = 2. */
export const POOL_MAX = 4;
export const AUTH_POOL_MAX = 2;

process.env.DATABASE_POOL_MAX = String(POOL_MAX);
