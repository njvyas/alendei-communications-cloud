import { Injectable } from '@nestjs/common';

/**
 * The clock and the wait an adapter submission is timed by (Phase 2.2).
 *
 * Injected, never ambient, so the simulator's latency and the executor's
 * timeout are deterministic under test: a test drives a virtual clock instead
 * of sleeping on the wall clock (ADR-013, Gate D determinism).
 */
export interface SubmissionTimer {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  /**
   * Resolves after `ms`; `Infinity` never resolves on its own. Resolves early if
   * `signal` aborts, so a timed-out or cancelled wait never holds a timer.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const SUBMISSION_TIMER = Symbol('SUBMISSION_TIMER');

@Injectable()
export class RealSubmissionTimer implements SubmissionTimer {
  now(): number {
    return performance.now();
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
      signal?.addEventListener('abort', done, { once: true });
      function done() {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
    });
  }
}
