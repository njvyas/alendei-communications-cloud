/**
 * Imported first by `dispatch-worker.int-spec.ts`. Configuration is validated
 * once, when the application module is loaded, so the dispatch loop has to be
 * switched on before anything imports it; `setup-env.ts` switches it off for
 * every other suite. A short poll keeps the suite fast without changing what
 * the loop does.
 */
export const POLL_INTERVAL_MS = 100;
export const PREVIOUS = {
  DISPATCH_WORKER_ENABLED: process.env.DISPATCH_WORKER_ENABLED,
  DISPATCH_WORKER_POLL_INTERVAL_MS: process.env.DISPATCH_WORKER_POLL_INTERVAL_MS,
};

process.env.DISPATCH_WORKER_ENABLED = 'true';
process.env.DISPATCH_WORKER_POLL_INTERVAL_MS = String(POLL_INTERVAL_MS);
