import { Injectable } from '@nestjs/common';

/**
 * The clock every health and circuit decision is made on (Phase 2.3,
 * `PROVIDER_ADAPTER.md` §6a).
 *
 * Injected, never ambient: windows, cooldowns and probe leases are compared
 * against `now()` and nothing else, so a test drives every boundary to the
 * millisecond without sleeping (ADR-013 F-7, Gate D determinism). The value is
 * persisted (`observed_at`, `circuit_changed_at`), so it is wall-clock time,
 * not a monotonic counter.
 */
export interface ProviderClock {
  now(): Date;
}

export const PROVIDER_CLOCK = Symbol('PROVIDER_CLOCK');

@Injectable()
export class SystemProviderClock implements ProviderClock {
  now(): Date {
    return new Date();
  }
}
