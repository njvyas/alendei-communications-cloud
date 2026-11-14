/** Injection tokens for the two database principals the API connects as. */
export const APP_POOL = Symbol('APP_POOL');
export const APP_DB = Symbol('APP_DB');
export const AUTH_POOL = Symbol('AUTH_POOL');
export const AUTH_DB = Symbol('AUTH_DB');
export const DISPATCH_POOL = Symbol('DISPATCH_POOL');
export const DISPATCH_DB = Symbol('DISPATCH_DB');
/** Phase 5.0: the delivery-receipt principal; the value is `null` while ingestion is disabled. */
export const DELIVERY_POOL = Symbol('DELIVERY_POOL');
export const DELIVERY_DB = Symbol('DELIVERY_DB');
/** Phase 8C PR 8C-3: the journey runner principal; `null` unless JOURNEY_RUNNER_ENABLED. */
export const JOURNEY_POOL = Symbol('JOURNEY_POOL');
export const JOURNEY_DB = Symbol('JOURNEY_DB');
