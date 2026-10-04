/**
 * Hot reload — runtime configuration convergence (Phase 2.4,
 * `PROVIDER_ADAPTER.md` §3a, ADR-013 "2.4 design").
 *
 * The advisory configuration snapshot each application instance keeps is
 * invalidated by PostgreSQL `NOTIFY` (an accelerator), reconciled against a
 * transactional revision every `RECONCILE_MS` and never served older than
 * `MAX_AGE_MS`. It is never consulted by authorization, administration,
 * lifecycle enforcement, circuit admission or a submission.
 */
export const PROVIDER_CONFIGURATION_CACHE = Object.freeze({
  /** `R`: the revision is re-checked on a read when it was last checked this long ago. */
  RECONCILE_MS: 5_000,
  /** `T`: no snapshot older than this is ever served, whatever the revision says. */
  MAX_AGE_MS: 60_000,
  /** The `LISTEN`/`NOTIFY` channel; the payload is the revision, a hint only. */
  NOTIFY_CHANNEL: 'acc_provider_configuration',
  /** Listener reconnect backoff after its connection is lost. */
  LISTENER_RECONNECT_MIN_MS: 1_000,
  LISTENER_RECONNECT_MAX_MS: 30_000,
});
