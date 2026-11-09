/**
 * Imported first by `phase7_4-reservation.int-spec.ts`. Configuration is
 * validated once, when the application module is loaded, so billing enforcement
 * has to be switched on before anything imports it; `setup-env.ts` switches it
 * off for every other suite. The startup guard admits it here because the
 * integration setup runs with `NODE_ENV=test` and `APP_ENV=test`.
 */
process.env.BILLING_ENFORCEMENT_ENABLED = 'true';
