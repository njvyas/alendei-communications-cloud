import { Inject, Injectable } from '@nestjs/common';

import { SUBMISSION_TIMER, type SubmissionTimer } from './submission-timer';

/**
 * Proof that the circuit admitted one submission to one provider
 * (`PROVIDER_ADAPTER.md` §6h, Gate D.3 final remediation).
 *
 * **Provider Router eligibility is advisory; circuit admission is
 * authoritative and mandatory immediately before provider submission.** An
 * admission is issued by `ProviderStateStore.admit` — and only there — when
 * the circuit admits a submission under the provider row lock, and is redeemed
 * by `ProviderSubmissionExecutor.execute` before any adapter is called. Its
 * fields are informational: what makes it an admission is that this registry
 * issued it, so a copy, a forgery or a routing-eligibility verdict carrying the
 * same fields is not one.
 */
export interface CircuitAdmission {
  readonly providerId: string;
  /** The circuit episode it was admitted in, and its probe slot when half-open (§6d). */
  readonly generation: number;
  readonly probeId: string | null;
}

/** A provider call was attempted without a valid circuit admission. Nothing was sent. */
export class CircuitAdmissionRequired extends Error {
  constructor(readonly reason: string) {
    super(`Provider submission refused: ${reason} (circuit admission is mandatory)`);
    this.name = 'CircuitAdmissionRequired';
  }
}

interface Issued {
  readonly providerId: string;
  readonly issuedAt: number;
  consumed: boolean;
}

/**
 * The registry of issued admissions. Process-local by design: an admission
 * cannot be serialized, cached or carried to another instance — admission and
 * provider call happen in the same request. Entries are held weakly, so an
 * admission nobody redeems is simply collected.
 */
@Injectable()
export class CircuitAdmissions {
  /** An admission must be redeemed this soon after it was issued (on the submission clock). */
  static readonly MAX_AGE_MS = 5_000;

  private readonly issued = new WeakMap<object, Issued>();

  constructor(@Inject(SUBMISSION_TIMER) private readonly timer: SubmissionTimer) {}

  /**
   * Issues an admission. **Only `ProviderStateStore.admit` may call this**, and
   * only for a submission the circuit admitted under the provider row lock; an
   * architecture test pins it (`circuit-admission.architecture.spec.ts`).
   */
  issue(
    providerId: string,
    ticket: { readonly generation: number; readonly probeId: string | null },
  ): CircuitAdmission {
    const admission: CircuitAdmission = Object.freeze({
      providerId,
      generation: ticket.generation,
      probeId: ticket.probeId,
    });
    this.issued.set(admission, { providerId, issuedAt: this.timer.now(), consumed: false });
    return admission;
  }

  /**
   * Redeems `admission` for a call to `providerId`, exactly once, or throws
   * `CircuitAdmissionRequired`. Called by the executor before the adapter.
   */
  consume(admission: unknown, providerId: string): CircuitAdmission {
    const record =
      typeof admission === 'object' && admission !== null ? this.issued.get(admission) : undefined;
    if (!record) throw new CircuitAdmissionRequired('not an admission issued by the circuit');
    if (record.consumed) throw new CircuitAdmissionRequired('admission already used');
    if (record.providerId !== providerId) {
      throw new CircuitAdmissionRequired('admission was issued for another provider');
    }
    if (this.timer.now() - record.issuedAt > CircuitAdmissions.MAX_AGE_MS) {
      throw new CircuitAdmissionRequired('admission expired');
    }
    record.consumed = true;
    return admission as CircuitAdmission;
  }
}
