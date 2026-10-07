import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  PROVIDER_ADAPTER_KEYS,
  PROVIDER_CIRCUIT_STATES,
  PROVIDER_HEALTH_DEFAULTS,
  PROVIDER_HEALTH_STATES,
  type AuthPrincipal,
  type ProviderCircuitPolicy,
  type ProviderCircuitState,
  type ProviderHealthClassification,
  type ProviderHealthSampleKind,
  type ProviderHealthState,
  type ProviderProbeOutcome,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, desc, eq, gt, inArray, lte, ne } from 'drizzle-orm';

import { RequestContext } from '../common/context/request-context';
import {
  CircuitAdmissions,
  type AdmissionIssuer,
  type CircuitAdmission,
  type SettledSubmission,
} from '../provider-adapters/circuit-admission';
import { MetricsService } from '../observability/metrics.service';
import { ProviderAccess } from './provider-access.service';
import { PROVIDER_CLOCK, type ProviderClock } from './provider-clock';
import {
  admit,
  classifyProbe,
  classifySubmission,
  effectiveHealth,
  recordSubmission,
  submissionOutcome,
  type CircuitSnapshot,
  type CircuitTransition,
  type HealthWindowSample,
} from './provider-state-machine';
import {
  adapterNotRegistered,
  channelCodeOf,
  circuitPolicyOf,
  circuitSnapshot,
  lifecycleConflict,
  loadCircuitPolicy,
  loadProvider,
  readCapabilities,
  type ProviderRow,
} from './provider-views';

export type Admission =
  | {
      readonly admitted: true;
      /**
       * The capability the provider call must redeem (§6h). Issued only here;
       * it carries the provider, adapter, channel, capabilities, ticket and
       * timeout the executor will use — the caller supplies none of them.
       */
      readonly admission: CircuitAdmission;
    }
  | {
      readonly admitted: false;
      readonly state: 'open' | 'half_open';
      readonly retryAfterMs: number | null;
    };

/** The provider's health and circuit state after an observation was recorded. */
export interface RecordedState {
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
}

type HealthCause = 'submission' | 'probe' | 'override';

/**
 * The only writer of provider health and circuit state (Phase 2.3,
 * `PROVIDER_ADAPTER.md` §5-§6).
 *
 * Every method runs inside its caller's request transaction, after the
 * caller's authorization, and works on the provider row **locked `FOR
 * UPDATE`**: the state, the windows and the decision are read and made under
 * that lock, and the sample, the new state and their audit rows are written
 * before it is released (§6e). The decisions themselves are the pure functions
 * of `provider-state-machine.ts`; this class supplies the clock, the windows
 * and the persistence, and records every transition — `provider.circuit_changed`
 * and `provider.health_changed` audit rows, metrics and a log line.
 */
@Injectable()
export class ProviderStateStore {
  private readonly logger = new Logger(ProviderStateStore.name);
  /** The admission ledger's one issuer (ADR-015 R-13): claimed here, so no other code can issue. */
  readonly #issuer: AdmissionIssuer;

  constructor(
    private readonly access: ProviderAccess,
    admissions: CircuitAdmissions,
    @Inject(PROVIDER_CLOCK) private readonly clock: ProviderClock,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    this.#issuer = admissions.claimIssuer();
  }

  /**
   * Admission of one submission (§6c), in the fixed precedence of §6f: the
   * provider is locked `FOR UPDATE` here (a caller that already holds the lock
   * re-takes it harmlessly in the same transaction); only an `active` provider
   * is a submission target (`409`, the circuit never consulted); its catalogue
   * adapter key must be registered (`422`); then the circuit decides. A
   * circuit refusal changes nothing and is the caller's to record. An admitted
   * submission gets a `CircuitAdmission` carrying the channel and the
   * capabilities read under the same lock.
   */
  async admit(tx: Transaction, principal: AuthPrincipal, providerId: string): Promise<Admission> {
    const provider = await loadProvider(tx, providerId, { forUpdate: true });
    if (provider.status !== 'active') throw lifecycleConflict(provider.status);
    if (!(PROVIDER_ADAPTER_KEYS as readonly string[]).includes(provider.adapterKey)) {
      throw adapterNotRegistered(provider, PROVIDER_ADAPTER_KEYS);
    }
    const now = this.clock.now();
    // The policy is read after the caller took the provider row lock, and this
    // one version governs the whole decision (§6a).
    const policyRow = await loadCircuitPolicy(tx);
    const before = circuitSnapshot(provider);
    const decision = admit(before, circuitPolicyOf(policyRow), now, randomUUID);

    if (!decision.admitted) {
      this.metrics?.providerCircuitRejections.inc({
        provider: provider.id,
        status: decision.state,
      });
      this.logger.log({
        msg: 'provider circuit refused a submission',
        providerId: provider.id,
        circuitState: decision.state,
        retryAfterMs: decision.retryAfterMs,
        correlationId: RequestContext.correlationId(),
      });
      return decision;
    }

    if (decision.next !== before) {
      await this.persist(tx, provider.id, { circuit: decision.next });
      await this.recordTransitions(
        tx,
        principal,
        provider.id,
        before,
        decision.transitions,
        null,
        policyRow.version,
      );
      this.setCircuitGauge(provider.id, decision.next.state);
    }
    if (decision.reclaimedProbes > 0) {
      this.metrics?.providerCircuitProbes.inc(
        { provider: provider.id, outcome: 'abandoned' },
        decision.reclaimedProbes,
      );
      this.logger.warn({
        msg: 'provider circuit probe slots reclaimed after their lease expired',
        reclaimed: decision.reclaimedProbes,
        providerId: provider.id,
        circuitGeneration: decision.next.generation,
        correlationId: RequestContext.correlationId(),
      });
    }
    const channel = await channelCodeOf(tx, provider.channelId);
    const capabilities = await readCapabilities(tx, provider.id);
    // The only place an admission is issued: the circuit has just admitted this
    // submission under the provider row lock (§6h).
    return {
      admitted: true,
      admission: this.#issuer.issue({
        providerId: provider.id,
        adapterKey: provider.adapterKey,
        channel,
        capabilities: Object.fromEntries(capabilities.map((c) => [c.key, c.value])),
        ticket: decision.ticket,
        circuitPolicyVersion: policyRow.version,
      }),
    };
  }

  /**
   * Records a submission the adapter answered (§6d), and its effect on health
   * (§5c). Takes only the settled submission the executor returned: the
   * provider, the ticket and the result come from the admission ledger, once —
   * a plain ticket, an admission whose call has not settled, a forgery or a
   * second recording is refused (`CircuitAdmissionRequired`) before anything
   * is read or written.
   */
  async recordSubmission(
    tx: Transaction,
    principal: AuthPrincipal,
    settled: SettledSubmission,
  ): Promise<RecordedState> {
    const { providerId, ticket, result } = this.#issuer.takeForRecording(settled);
    const provider = await loadProvider(tx, providerId, { forUpdate: true });
    const now = this.clock.now();
    const outcome = submissionOutcome(result);
    const classification = classifySubmission(outcome);
    const policyRow = await loadCircuitPolicy(tx);
    const policy = circuitPolicyOf(policyRow);
    const before = circuitSnapshot(provider);

    // The circuit window is read only where T1 can be evaluated (§6d).
    const evaluates =
      ticket.generation === before.generation &&
      ticket.probeId === null &&
      before.state === 'closed' &&
      classification !== 'neutral';
    const circuitWindow = evaluates
      ? [
          { classification: classification as 'success' | 'failure' },
          ...(await this.circuitWindow(tx, providerId, before.generation, policy, now)),
        ].slice(0, policy.windowMaxSamples)
      : [];
    const decision = recordSubmission(before, ticket, classification, circuitWindow, policy, now);

    const healthState = effectiveHealth(
      provider.healthOverride,
      await this.healthWindow(tx, providerId, now, { classification, latencyMs: result.latencyMs }),
    );

    await this.insertSample(tx, {
      providerId,
      kind: 'submission',
      outcome,
      classification,
      latencyMs: result.latencyMs,
      healthState,
      circuitState: decision.next.state,
      circuitGeneration: ticket.generation,
      circuitPolicyVersion: policyRow.version,
      observedAt: now,
    });
    await this.persist(tx, providerId, {
      circuit: decision.next !== before ? decision.next : undefined,
      health: healthState !== provider.healthState ? { state: healthState, at: now } : undefined,
    });
    await this.recordTransitions(
      tx,
      principal,
      providerId,
      before,
      decision.transitions,
      decision.window,
      policyRow.version,
    );
    await this.recordHealthChange(tx, principal, provider, healthState, 'submission');

    if (ticket.probeId !== null) {
      this.metrics?.providerCircuitProbes.inc({
        provider: providerId,
        outcome: decision.effect === 'stale' ? 'stale' : decision.effect.slice('probe_'.length),
      });
    }
    this.setCircuitGauge(providerId, decision.next.state);
    this.setHealthGauge(providerId, healthState);
    return { healthState, circuitState: decision.next.state };
  }

  /** Records a health-check probe (§5e). Health only: a probe never moves the circuit. */
  async recordProbe(
    tx: Transaction,
    principal: AuthPrincipal,
    providerId: string,
    probe: { readonly outcome: ProviderProbeOutcome; readonly latencyMs: number },
  ): Promise<RecordedState> {
    const provider = await loadProvider(tx, providerId, { forUpdate: true });
    const now = this.clock.now();
    const policyVersion = (await loadCircuitPolicy(tx)).version;
    const classification = classifyProbe(probe.outcome);
    const healthState = effectiveHealth(
      provider.healthOverride,
      await this.healthWindow(tx, providerId, now, { classification, latencyMs: probe.latencyMs }),
    );

    await this.insertSample(tx, {
      providerId,
      kind: 'probe',
      outcome: probe.outcome,
      classification,
      latencyMs: probe.latencyMs,
      healthState,
      circuitState: provider.circuitState,
      circuitGeneration: provider.circuitGeneration,
      circuitPolicyVersion: policyVersion,
      observedAt: now,
    });
    if (healthState !== provider.healthState) {
      await this.persist(tx, providerId, { health: { state: healthState, at: now } });
    }
    await this.recordHealthChange(tx, principal, provider, healthState, 'probe');
    this.setHealthGauge(providerId, healthState);
    return { healthState, circuitState: provider.circuitState };
  }

  /**
   * Sets or clears the manual override (§5d). Setting the override already in
   * force changes nothing and records nothing; otherwise the override sample,
   * `provider.health_overridden` and any `provider.health_changed` are written.
   */
  async setOverride(
    tx: Transaction,
    principal: AuthPrincipal,
    providerId: string,
    override: ProviderHealthState | null,
    reason: string | null,
  ): Promise<ProviderRow> {
    const provider = await loadProvider(tx, providerId, { forUpdate: true });
    if (provider.healthOverride === override) return provider;

    const now = this.clock.now();
    const policyVersion = (await loadCircuitPolicy(tx)).version;
    const healthState = effectiveHealth(override, await this.healthWindow(tx, providerId, now));
    await this.insertSample(tx, {
      providerId,
      kind: 'override',
      outcome: 'manual',
      classification: 'neutral',
      latencyMs: null,
      healthState,
      circuitState: provider.circuitState,
      circuitGeneration: provider.circuitGeneration,
      circuitPolicyVersion: policyVersion,
      observedAt: now,
    });
    const row = await this.persist(tx, providerId, {
      override: { value: override },
      health: healthState !== provider.healthState ? { state: healthState, at: now } : undefined,
    });
    await this.access.record(
      tx,
      principal,
      AUDIT_ACTIONS.PROVIDER_HEALTH_OVERRIDDEN,
      providerId,
      { healthOverride: provider.healthOverride, healthState: provider.healthState },
      { healthOverride: override, healthState, reason },
    );
    await this.recordHealthChange(tx, principal, provider, healthState, 'override');
    this.setHealthGauge(providerId, healthState);
    return row;
  }

  // --- windows -------------------------------------------------------------------

  /**
   * The counted submission samples of `generation` inside the circuit window,
   * newest first, one short of the maximum (the caller prepends the sample being
   * recorded, which is the newest).
   */
  private async circuitWindow(
    tx: Transaction,
    providerId: string,
    generation: number,
    policy: ProviderCircuitPolicy,
    now: Date,
  ): Promise<{ classification: 'success' | 'failure' }[]> {
    const h = schema.providerHealth;
    const rows = await tx
      .select({ classification: h.classification })
      .from(h)
      .where(
        and(
          eq(h.providerId, providerId),
          eq(h.kind, 'submission'),
          eq(h.circuitGeneration, generation),
          ne(h.classification, 'neutral'),
          gt(h.observedAt, new Date(now.getTime() - policy.windowMs)),
          lte(h.observedAt, now),
        ),
      )
      .orderBy(desc(h.observedAt), desc(h.id))
      .limit(Math.max(0, policy.windowMaxSamples - 1));
    return rows as { classification: 'success' | 'failure' }[];
  }

  /** The health window (§5c), newest first, including `latest` when it counts. */
  private async healthWindow(
    tx: Transaction,
    providerId: string,
    now: Date,
    latest?: { classification: ProviderHealthClassification; latencyMs: number },
  ): Promise<HealthWindowSample[]> {
    const h = schema.providerHealth;
    const rows = await tx
      .select({ classification: h.classification, latencyMs: h.latencyMs })
      .from(h)
      .where(
        and(
          eq(h.providerId, providerId),
          inArray(h.kind, ['submission', 'probe']),
          ne(h.classification, 'neutral'),
          gt(h.observedAt, new Date(now.getTime() - PROVIDER_HEALTH_DEFAULTS.WINDOW_MS)),
          lte(h.observedAt, now),
        ),
      )
      .orderBy(desc(h.observedAt), desc(h.id))
      .limit(PROVIDER_HEALTH_DEFAULTS.WINDOW_MAX_SAMPLES);
    const prior = rows.map((r) => ({
      classification: r.classification as 'success' | 'failure',
      latencyMs: r.latencyMs ?? 0,
    }));
    const window =
      latest && latest.classification !== 'neutral'
        ? [{ classification: latest.classification, latencyMs: latest.latencyMs }, ...prior]
        : prior;
    return window.slice(0, PROVIDER_HEALTH_DEFAULTS.WINDOW_MAX_SAMPLES);
  }

  // --- persistence ---------------------------------------------------------------

  private async insertSample(
    tx: Transaction,
    sample: {
      providerId: string;
      kind: ProviderHealthSampleKind;
      outcome: string;
      classification: ProviderHealthClassification;
      latencyMs: number | null;
      healthState: ProviderHealthState;
      circuitState: ProviderCircuitState;
      circuitGeneration: number;
      circuitPolicyVersion: number;
      observedAt: Date;
    },
  ): Promise<void> {
    await tx.insert(schema.providerHealth).values({
      ...sample,
      source: sample.kind === 'override' ? 'manual' : 'automatic',
    });
  }

  /** Writes only the columns that changed, on the row the caller holds locked. */
  private async persist(
    tx: Transaction,
    providerId: string,
    change: {
      circuit?: CircuitSnapshot;
      health?: { state: ProviderHealthState; at: Date };
      override?: { value: ProviderHealthState | null };
    },
  ): Promise<ProviderRow> {
    const set: Partial<typeof schema.providers.$inferInsert> = {};
    if (change.circuit) {
      set.circuitState = change.circuit.state;
      set.circuitGeneration = change.circuit.generation;
      set.circuitChangedAt = change.circuit.changedAt;
      set.circuitProbes = change.circuit.probes.map((p) => ({
        id: p.id,
        leaseUntil: p.leaseUntil.toISOString(),
      }));
      set.circuitProbeSuccesses = change.circuit.probeSuccesses;
    }
    if (change.health) {
      set.healthState = change.health.state;
      set.healthChangedAt = change.health.at;
    }
    if (change.override) set.healthOverride = change.override.value;
    if (Object.keys(set).length === 0) return loadProvider(tx, providerId);
    const [row] = await tx
      .update(schema.providers)
      .set(set)
      .where(eq(schema.providers.id, providerId))
      .returning();
    return row!;
  }

  // --- transitions: audit, metrics, logs ----------------------------------------------

  private async recordTransitions(
    tx: Transaction,
    principal: AuthPrincipal,
    providerId: string,
    before: CircuitSnapshot,
    transitions: readonly CircuitTransition[],
    window: { samples: number; failures: number } | null,
    policyVersion: number,
  ): Promise<void> {
    for (const t of transitions) {
      await this.access.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_CIRCUIT_CHANGED,
        providerId,
        { circuitState: t.from, circuitGeneration: t.generation - 1 },
        {
          circuitState: t.to,
          circuitGeneration: t.generation,
          cause: t.cause,
          circuitPolicyVersion: policyVersion,
          ...(t.key === 'T1' && window ? { window } : {}),
        },
      );
      this.metrics?.providerCircuitTransitions.inc({
        provider: providerId,
        from_state: t.from,
        to_state: t.to,
      });
      const line = {
        msg: `provider circuit ${t.from} -> ${t.to}`,
        providerId,
        cause: t.cause,
        circuitGeneration: t.generation,
        previousGeneration: before.generation,
        circuitPolicyVersion: policyVersion,
        correlationId: RequestContext.correlationId(),
      };
      if (t.to === 'open') this.logger.warn(line);
      else this.logger.log(line);
    }
  }

  private async recordHealthChange(
    tx: Transaction,
    principal: AuthPrincipal,
    provider: ProviderRow,
    healthState: ProviderHealthState,
    cause: HealthCause,
  ): Promise<void> {
    if (healthState === provider.healthState) return;
    await this.access.record(
      tx,
      principal,
      AUDIT_ACTIONS.PROVIDER_HEALTH_CHANGED,
      provider.id,
      { healthState: provider.healthState },
      { healthState, source: cause === 'override' ? 'manual' : 'automatic', cause },
    );
    this.metrics?.providerHealthTransitions.inc({
      provider: provider.id,
      from_state: provider.healthState,
      to_state: healthState,
    });
    const line = {
      msg: `provider health ${provider.healthState} -> ${healthState}`,
      providerId: provider.id,
      cause,
      correlationId: RequestContext.correlationId(),
    };
    if (healthState === 'critical' || healthState === 'offline') this.logger.warn(line);
    else this.logger.log(line);
  }

  private setCircuitGauge(providerId: string, state: ProviderCircuitState): void {
    for (const s of PROVIDER_CIRCUIT_STATES) {
      this.metrics?.providerCircuitState.set(
        { provider: providerId, status: s },
        s === state ? 1 : 0,
      );
    }
  }

  private setHealthGauge(providerId: string, state: ProviderHealthState): void {
    for (const s of PROVIDER_HEALTH_STATES) {
      this.metrics?.providerHealthState.set(
        { provider: providerId, status: s },
        s === state ? 1 : 0,
      );
    }
  }
}
