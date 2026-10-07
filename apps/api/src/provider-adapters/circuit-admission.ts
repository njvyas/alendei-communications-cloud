import {
  PROVIDER_SUBMISSION_DEFAULTS,
  type ChannelCode,
  type ProviderAdapter,
  type ProviderAdapterCapabilities,
  type ProviderAdapterContext,
  type ProviderHealthCheckOptions,
  type ProviderHealthProbe,
  type ProviderSubmission,
  type ProviderSubmissionOptions,
  type ProviderSubmissionResult,
  type SubmissionPermit,
} from '@acc/contracts';

import type { SubmissionTimer } from './submission-timer';

/**
 * The circuit-admission ledger (`PROVIDER_ADAPTER.md` §6h; Gate D.3 final
 * remediation, made structural by ADR-015 R-13).
 *
 * **Provider Router eligibility is advisory; circuit admission is
 * authoritative and mandatory immediately before provider submission.** One
 * admission covers one provider call, and its whole life is kept here:
 *
 *   issued    `ProviderStateStore.admit`, under the provider row lock, through
 *             the ledger's one issuer (`claimIssuer`)
 *   redeemed  `ProviderSubmissionExecutor.execute`, through the ledger's one
 *             redeemer (`claimRedeemer`), which binds the submission and
 *             mints the permit for exactly one adapter instance
 *   invoked   `GuardedProviderAdapter.send`, which refuses — before anything
 *             is sent — a permit that is not redeemed, or is for another
 *             adapter, provider or submission
 *   settled   the executor, with the normalized result it measured
 *   recorded  `ProviderStateStore.recordSubmission`, which takes provider,
 *             ticket and result from here — never from its caller — once
 *   void      expired before it was redeemed
 *
 * Every capability (admission, redemption, permit, settled submission) is a
 * frozen instance of a class with a private constructor whose ES `#record`
 * slot only this module can read, so a plain object, a JSON round-trip, a
 * spread copy, a cast or an `Object.create` clone carries no record and is
 * refused. Process-local by design: nothing here can be serialized or carried
 * to another instance.
 *
 * What this is not: a boundary against hostile code in the same process. A
 * second ledger with its own executor, a cast that reaches the protected
 * `submit()`, or monkey-patching are refused only by the import-boundary test
 * (`circuit-admission.architecture.spec.ts`) and review (`PROVIDER_ADAPTER.md`
 * §6h, residual limits).
 */

/** A provider call was attempted without a valid circuit admission. Nothing was sent. */
export class CircuitAdmissionRequired extends Error {
  constructor(readonly reason: string) {
    super(`Provider submission refused: ${reason} (circuit admission is mandatory)`);
    this.name = 'CircuitAdmissionRequired';
  }
}

/** An adapter that cannot be trusted to enforce the permit was offered for registration. */
export class ProviderAdapterRefused extends Error {
  constructor(adapterKey: unknown, reason: string) {
    super(`Provider adapter "${String(adapterKey)}" refused: ${reason}`);
    this.name = 'ProviderAdapterRefused';
  }
}

export type AdmissionState = 'issued' | 'redeemed' | 'invoked' | 'settled' | 'recorded' | 'void';

/** The circuit episode a submission was admitted in, and its probe slot when half-open (§6d). */
export interface AdmissionTicket {
  readonly generation: number;
  readonly probeId: string | null;
}

/** What the circuit admitted, read by the store under the provider row lock. */
export interface AdmissionGrant {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channel: ChannelCode;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly ticket: AdmissionTicket;
  readonly circuitPolicyVersion: number;
}

/** What recording takes from the ledger — never from the caller (§6d). */
export interface SettledRecord {
  readonly providerId: string;
  readonly ticket: AdmissionTicket;
  readonly result: ProviderSubmissionResult;
  /** The policy version the admission was decided under (informational; recording reads the current one). */
  readonly circuitPolicyVersion: number;
}

/** The submission timeout and signal the adapter's `submit()` receives — the ledger's, never a caller's. */
export interface AdapterSubmitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface AdmissionRecord {
  readonly ledger: CircuitAdmissions;
  state: AdmissionState;
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channel: ChannelCode;
  /** Deep-frozen; built once, at issue, from what was read under the row lock. */
  readonly context: ProviderAdapterContext;
  readonly ticket: AdmissionTicket;
  readonly circuitPolicyVersion: number;
  readonly issuedAt: number;
  readonly redeemBy: number;
  readonly timeoutMs: number;
  submissionId: string | null;
  correlationId: string | null;
  /** The one adapter instance the permit may be presented to. */
  target: GuardedProviderAdapter | null;
  result: ProviderSubmissionResult | null;
}

// Module-private accessors, assigned by each capability class's static block.
// Nothing outside this file can read a record or mint a capability.
let admissionRecord: (value: unknown) => AdmissionRecord | undefined;
let mintAdmission: (record: AdmissionRecord) => CircuitAdmission;
let redemptionRecord: (value: unknown) => AdmissionRecord | undefined;
let mintRedemption: (record: AdmissionRecord) => Redemption;
let permitRecord: (value: unknown) => AdmissionRecord | undefined;
let mintPermit: (record: AdmissionRecord) => SubmissionPermit;
let settledRecord: (value: unknown) => AdmissionRecord | undefined;
let mintSettled: (record: AdmissionRecord) => SettledSubmission;

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

/**
 * Proof that the circuit admitted one submission to one provider. Its fields
 * are informational; what makes it an admission is the record behind it.
 */
export class CircuitAdmission {
  readonly #record: AdmissionRecord;
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channel: ChannelCode;
  readonly generation: number;
  readonly probeId: string | null;

  private constructor(record: AdmissionRecord) {
    this.#record = record;
    this.providerId = record.providerId;
    this.adapterKey = record.adapterKey;
    this.channel = record.channel;
    this.generation = record.ticket.generation;
    this.probeId = record.ticket.probeId;
    Object.freeze(this);
  }

  static {
    admissionRecord = (value) => (isObject(value) && #record in value ? value.#record : undefined);
    mintAdmission = (record) => new CircuitAdmission(record);
  }
}

/** The executor's handle on a redeemed admission: what it may call, with what, for how long. */
export class Redemption {
  readonly #record: AdmissionRecord;
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channel: ChannelCode;
  readonly context: ProviderAdapterContext;
  readonly timeoutMs: number;

  private constructor(record: AdmissionRecord) {
    this.#record = record;
    this.providerId = record.providerId;
    this.adapterKey = record.adapterKey;
    this.channel = record.channel;
    this.context = record.context;
    this.timeoutMs = record.timeoutMs;
    Object.freeze(this);
  }

  static {
    redemptionRecord = (value) => (isObject(value) && #record in value ? value.#record : undefined);
    mintRedemption = (record) => new Redemption(record);
  }
}

/** The opaque permit an adapter's `send()` consumes. Nothing about it is readable. */
export class Permit {
  readonly #record: AdmissionRecord;

  private constructor(record: AdmissionRecord) {
    this.#record = record;
    Object.freeze(this);
  }

  static {
    permitRecord = (value) => (isObject(value) && #record in value ? value.#record : undefined);
    // The one place a permit is typed as the contract's opaque `SubmissionPermit`.
    mintPermit = (record) => new Permit(record) as unknown as SubmissionPermit;
  }
}

/**
 * A submission the provider answered (or the executor timed out), with the
 * normalized result. The only thing `recordSubmission` accepts, once.
 */
export class SettledSubmission {
  readonly #record: AdmissionRecord;
  readonly providerId: string;
  readonly circuitProbe: boolean;
  readonly result: ProviderSubmissionResult;

  private constructor(record: AdmissionRecord) {
    this.#record = record;
    this.providerId = record.providerId;
    this.circuitProbe = record.ticket.probeId !== null;
    this.result = record.result!;
    Object.freeze(this);
  }

  static {
    settledRecord = (value) => (isObject(value) && #record in value ? value.#record : undefined);
    mintSettled = (record) => new SettledSubmission(record);
  }
}

/** Issues admissions and takes settled ones for recording. Held by `ProviderStateStore` only. */
export interface AdmissionIssuer {
  issue(grant: AdmissionGrant): CircuitAdmission;
  takeForRecording(settled: SettledSubmission): SettledRecord;
}

/** Redeems admissions, mints permits and settles results. Held by `ProviderSubmissionExecutor` only. */
export interface AdmissionRedeemer {
  redeem(admission: unknown, submission: ProviderSubmission): Redemption;
  authorize(redemption: Redemption, target: GuardedProviderAdapter): SubmissionPermit;
  settle(redemption: Redemption, result: ProviderSubmissionResult): SettledSubmission;
}

/**
 * The ledger. One per process (a Nest singleton); its issuer and its redeemer
 * can each be claimed exactly once, so a second store or executor on the same
 * ledger fails at boot.
 */
export class CircuitAdmissions {
  /** An admission must be redeemed this soon after it was issued (on the submission clock). */
  static readonly MAX_AGE_MS = 5_000;

  readonly #timer: SubmissionTimer;
  readonly #timeoutMs: number;
  #issuerClaimed = false;
  #redeemerClaimed = false;

  /**
   * `options.submissionTimeoutMs` is the timeout stamped on every admission;
   * the platform default unless a test builds its own ledger.
   */
  constructor(timer: SubmissionTimer, options: { readonly submissionTimeoutMs?: number } = {}) {
    const timeoutMs = options.submissionTimeoutMs ?? PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`CircuitAdmissions: invalid submission timeout ${timeoutMs}`);
    }
    this.#timer = timer;
    this.#timeoutMs = timeoutMs;
    Object.freeze(this);
  }

  /** The ledger's one issuer. Claimed by `ProviderStateStore`; a second claim throws. */
  claimIssuer(): AdmissionIssuer {
    if (this.#issuerClaimed) {
      throw new Error('CircuitAdmissions: the issuer is already claimed (one issuer per ledger)');
    }
    this.#issuerClaimed = true;
    return Object.freeze({
      issue: (grant: AdmissionGrant) => this.#issue(grant),
      takeForRecording: (settled: SettledSubmission) => this.#takeForRecording(settled),
    });
  }

  /** The ledger's one redeemer. Claimed by `ProviderSubmissionExecutor`; a second claim throws. */
  claimRedeemer(): AdmissionRedeemer {
    if (this.#redeemerClaimed) {
      throw new Error(
        'CircuitAdmissions: the redeemer is already claimed (one redeemer per ledger)',
      );
    }
    this.#redeemerClaimed = true;
    return Object.freeze({
      redeem: (admission: unknown, submission: ProviderSubmission) =>
        this.#redeem(admission, submission),
      authorize: (redemption: Redemption, target: GuardedProviderAdapter) =>
        this.#authorize(redemption, target),
      settle: (redemption: Redemption, result: ProviderSubmissionResult) =>
        this.#settle(redemption, result),
    });
  }

  #issue(grant: AdmissionGrant): CircuitAdmission {
    const issuedAt = this.#timer.now();
    const ticket = Object.freeze({
      generation: grant.ticket.generation,
      probeId: grant.ticket.probeId,
    });
    const context: ProviderAdapterContext = Object.freeze({
      providerId: grant.providerId,
      adapterKey: grant.adapterKey,
      channel: grant.channel,
      capabilities: deepFrozenCopy(grant.capabilities),
    });
    return mintAdmission({
      ledger: this,
      state: 'issued',
      providerId: grant.providerId,
      adapterKey: grant.adapterKey,
      channel: grant.channel,
      context,
      ticket,
      circuitPolicyVersion: grant.circuitPolicyVersion,
      issuedAt,
      redeemBy: issuedAt + CircuitAdmissions.MAX_AGE_MS,
      timeoutMs: this.#timeoutMs,
      submissionId: null,
      correlationId: null,
      target: null,
      result: null,
    });
  }

  #redeem(admission: unknown, submission: ProviderSubmission): Redemption {
    const record = admissionRecord(admission);
    if (!record) throw new CircuitAdmissionRequired('not an admission issued by the circuit');
    if (record.ledger !== this) {
      throw new CircuitAdmissionRequired('admission was issued by another ledger');
    }
    if (record.state !== 'issued') throw new CircuitAdmissionRequired('admission already used');
    if (this.#timer.now() > record.redeemBy) {
      record.state = 'void';
      throw new CircuitAdmissionRequired('admission expired');
    }
    record.state = 'redeemed';
    record.submissionId = submission.submissionId;
    record.correlationId = submission.correlationId;
    return mintRedemption(record);
  }

  #authorize(redemption: Redemption, target: GuardedProviderAdapter): SubmissionPermit {
    const record = this.#own(redemptionRecord(redemption));
    if (record.state !== 'redeemed' || record.target !== null) {
      throw new CircuitAdmissionRequired('admission is not awaiting its provider call');
    }
    record.target = target;
    return mintPermit(record);
  }

  #settle(redemption: Redemption, result: ProviderSubmissionResult): SettledSubmission {
    const record = this.#own(redemptionRecord(redemption));
    if (record.state !== 'invoked') {
      throw new CircuitAdmissionRequired('no provider call was made under this admission');
    }
    record.result = deepFrozenCopy(result);
    record.state = 'settled';
    return mintSettled(record);
  }

  #takeForRecording(settled: SettledSubmission): SettledRecord {
    const record = settledRecord(settled);
    if (!record) {
      throw new CircuitAdmissionRequired('not a settled submission: nothing to record');
    }
    if (record.ledger !== this) {
      throw new CircuitAdmissionRequired('settled submission belongs to another ledger');
    }
    if (record.state !== 'settled') {
      throw new CircuitAdmissionRequired('settled submission already recorded');
    }
    record.state = 'recorded';
    return Object.freeze({
      providerId: record.providerId,
      ticket: record.ticket,
      result: record.result!,
      circuitPolicyVersion: record.circuitPolicyVersion,
    });
  }

  #own(record: AdmissionRecord | undefined): AdmissionRecord {
    if (!record || record.ledger !== this) {
      throw new CircuitAdmissionRequired('not a redemption of this ledger');
    }
    return record;
  }
}

/**
 * Checks `permit` for this call and moves its admission to `invoked`, or
 * throws `CircuitAdmissionRequired`. Module-private: reached only through
 * `GuardedProviderAdapter.send`.
 */
function invoke(
  permit: unknown,
  adapter: GuardedProviderAdapter,
  context: ProviderAdapterContext,
  submission: ProviderSubmission,
): AdmissionRecord {
  const record = permitRecord(permit);
  if (!record) {
    throw new CircuitAdmissionRequired(
      'no submission permit: an adapter is reached only through the submission executor',
    );
  }
  if (record.state !== 'redeemed') throw new CircuitAdmissionRequired('permit already used');
  if (record.target !== adapter) {
    throw new CircuitAdmissionRequired('permit was issued for another adapter');
  }
  if (context?.providerId !== record.providerId) {
    throw new CircuitAdmissionRequired('permit was issued for another provider');
  }
  if (submission?.submissionId !== record.submissionId) {
    throw new CircuitAdmissionRequired('permit was issued for another submission');
  }
  record.state = 'invoked';
  return record;
}

let isGuardedInstance: (value: unknown) => boolean;

/**
 * The base every provider adapter extends (ADR-015 R-13). Its public `send()`
 * is the guard: it refuses — before anything is sent — any call whose permit
 * the ledger did not mint for this adapter instance, this provider and this
 * submission, then hands the subclass's protected `submit()` the context and
 * timeout **from the admission**, not the caller's.
 *
 * A subclass must not override `send()` (refused here at construction, and by
 * the registry, which also requires the instance to be frozen so `send` cannot
 * be replaced afterwards). The prototype is frozen.
 */
export abstract class GuardedProviderAdapter implements ProviderAdapter {
  readonly #guarded = true;
  abstract readonly adapterKey: string;

  protected constructor() {
    if (this.send !== GuardedProviderAdapter.prototype.send) {
      throw new ProviderAdapterRefused(new.target.name, 'it overrides send()');
    }
  }

  async send(
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    options: ProviderSubmissionOptions,
  ): Promise<ProviderSubmissionResult> {
    const record = invoke(options?.permit, this, context, submission);
    return this.submit(record.context, submission, {
      timeoutMs: record.timeoutMs,
      signal: options.signal,
    });
  }

  /** The provider call itself. Reached only through `send()`, after the permit check. */
  protected abstract submit(
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
    options: AdapterSubmitOptions,
  ): Promise<ProviderSubmissionResult>;

  abstract capabilities(): ProviderAdapterCapabilities;
  abstract healthCheck(
    context: ProviderAdapterContext,
    options?: ProviderHealthCheckOptions,
  ): Promise<ProviderHealthProbe>;
  abstract estimateCost(
    context: ProviderAdapterContext,
    submission: ProviderSubmission,
  ): Promise<never>;
  abstract checkStatus(context: ProviderAdapterContext, providerMessageId: string): Promise<never>;
  abstract parseWebhook(context: ProviderAdapterContext, raw: unknown): Promise<never>;

  static {
    isGuardedInstance = (value) => isObject(value) && #guarded in value && value.#guarded;
  }
}
Object.freeze(GuardedProviderAdapter.prototype);
Object.freeze(GuardedProviderAdapter);

/**
 * Refuses an adapter that cannot be trusted to enforce the permit: not
 * constructed as a `GuardedProviderAdapter`, overriding `send()` (in a
 * subclass or by assignment), or not frozen.
 */
export function assertGuardedAdapter(adapter: unknown): asserts adapter is GuardedProviderAdapter {
  const key = isObject(adapter) ? (adapter as { adapterKey?: unknown }).adapterKey : adapter;
  if (!isGuardedInstance(adapter)) {
    throw new ProviderAdapterRefused(key, 'it is not a GuardedProviderAdapter');
  }
  if ((adapter as GuardedProviderAdapter).send !== GuardedProviderAdapter.prototype.send) {
    throw new ProviderAdapterRefused(key, 'it overrides send()');
  }
  if (!Object.isFrozen(adapter)) throw new ProviderAdapterRefused(key, 'it is not frozen');
}

/** A deep-frozen structured copy: nothing the ledger holds can be changed through a reference. */
function deepFrozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (isObject(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
  }
  return value;
}
