import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PROVIDER_ADAPTER_KEYS,
  PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS,
  PROVIDER_CAPABILITY_LIMITS,
  PROVIDER_SUBMISSION_DEFAULTS,
  PROVIDER_TRANSITIONS,
  type AuditAction,
  type AuthPrincipal,
  type ChannelCode,
  type PageInfo,
  type ProviderCircuitState,
  type ProviderFailure,
  type ProviderHealthState,
  type ProviderStatus,
  type ProviderTransition,
  type SimulatorBehavior,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { TenantDatabase } from '../database/tenant-database.service';
import {
  ProviderAdapterNotRegistered,
  ProviderAdapterRegistry,
} from '../provider-adapters/adapter-registry';
import { SimulatorAdapter } from '../provider-adapters/simulator.adapter';
import { ProviderSubmissionExecutor } from '../provider-adapters/submission-executor';
import { ProviderAccess } from './provider-access.service';
import { ProviderConfigurationCache } from './provider-configuration.cache';
import { ProviderStateStore, type Admission } from './provider-state.store';
import {
  channelCodeOf,
  channelView,
  lifecycleConflict,
  loadCircuitPolicy,
  loadProvider,
  notFound,
  providerDetail,
  providerView,
  readCapabilities,
  type ChannelView,
  type ProviderCapabilityView,
  type ProviderDetailView,
  type ProviderRow,
  type ProviderView,
} from './provider-views';
import type {
  CreateProviderDto,
  ProviderCapabilityDto,
  ReplaceProviderCapabilitiesDto,
  UpdateProviderDto,
} from './provider.dto';

export type {
  ChannelView,
  ProviderCapabilityView,
  ProviderDetailView,
  ProviderView,
} from './provider-views';

/** `POST /providers/:id/test-send` answer (`FRONTEND_API_CONTRACT.md` §32b). Exhaustive. */
export interface ProviderTestSendView {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channelCode: ChannelCode;
  readonly behavior: SimulatorBehavior;
  readonly submissionId: string;
  readonly correlationId: string;
  /** The provider's answer: accepted, or rejected with a normalized failure. A rejection is data, not an HTTP error. */
  readonly outcome: 'accepted' | 'rejected';
  readonly providerMessageId: string | null;
  readonly failure: ProviderFailure | null;
  readonly latencyMs: number;
  /** Whether this submission was the circuit's half-open probe (Phase 2.3). */
  readonly circuitProbe: boolean;
  /** The provider's health and circuit state after this answer was recorded (Phase 2.3). */
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
}

export interface ListProvidersFilter extends ListQueryInput {
  readonly channelId?: string;
  readonly status?: ProviderStatus;
}

const TRANSITION_ACTIONS: Readonly<Record<ProviderTransition, AuditAction>> = {
  enable: AUDIT_ACTIONS.PROVIDER_ENABLED,
  disable: AUDIT_ACTIONS.PROVIDER_DISABLED,
  drain: AUDIT_ACTIONS.PROVIDER_DRAINED,
};

/**
 * The channel and provider catalogue (Phase 2.1, ADR-013).
 *
 * **A global catalogue at platform scope.** No row carries a tenant, so there
 * is no tenant to pin a query to. The model is layered and names no role
 * (ADR-013 F-3): the authenticated principal must hold the route's
 * `providers.*` permission at `{ scopeType: 'platform' }` — decided by
 * `AuthorizationService.assert` inside the request's transaction
 * (`ProviderAccess.authorize`), which also puts every mutation inside the Gate C
 * pre-commit coverage boundary — and, beneath that, RLS admits only a
 * transaction whose user holds a validated platform-scope grant
 * (`app_has_platform_scope()`, migration `0018`). The request's selected
 * organization, if any, attributes a refusal in the audit trail and nothing
 * else: it is neither a target nor an authority here.
 *
 * **Authorize before disclosing.** Every operation asserts before it reads a
 * catalogue row, so an unauthorized caller learns nothing about which
 * providers or channels exist; an authorized caller gets `404` for an id that
 * does not exist.
 */
@Injectable()
export class ProviderRegistryService {
  private readonly logger = new Logger(ProviderRegistryService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
    private readonly lists: ListQuery,
    private readonly adapters: ProviderAdapterRegistry,
    private readonly executor: ProviderSubmissionExecutor,
    private readonly state: ProviderStateStore,
    private readonly configuration: ProviderConfigurationCache,
  ) {}

  /**
   * After a configuration mutation commits: this instance's advisory snapshot
   * is marked dirty at once (read-your-writes); every other instance learns
   * from the database's NOTIFY or, failing that, reconciliation (§3a). Never
   * part of the decision itself.
   */
  private async committed<T>(operation: string, work: Promise<T>): Promise<T> {
    const result = await work;
    this.configuration.invalidateLocal(operation);
    return result;
  }

  private readonly channelListSpec: ListQuerySpec = {
    sortable: {
      code: { column: schema.channels.code, encode: (row) => String(row.code) },
    },
    defaultSort: 'code',
    tieBreaker: schema.channels.id,
  };

  private readonly providerListSpec: ListQuerySpec = {
    sortable: {
      name: { column: schema.providers.name, encode: (row) => String(row.name) },
      // `id` (UUIDv7) rather than `created_at`: a cursor must round-trip exactly.
      createdAt: { column: schema.providers.id, encode: (row) => String(row.id) },
    },
    defaultSort: 'name',
    tieBreaker: schema.providers.id,
  };

  // --- channels -----------------------------------------------------------------

  async listChannels(
    principal: AuthPrincipal,
    filter: ListQueryInput = {},
  ): Promise<{ items: readonly ChannelView[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.channelListSpec);
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      return tx
        .select()
        .from(schema.channels)
        .where(resolved.after)
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
    });
    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.channelListSpec,
      (row) => String(row.id),
    );
    return { items: items.map((row) => channelView(row as never)), page };
  }

  async getChannel(principal: AuthPrincipal, id: string): Promise<ChannelView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      const [row] = await tx.select().from(schema.channels).where(eq(schema.channels.id, id));
      if (!row) throw notFound('Channel', id);
      return channelView(row);
    });
  }

  // --- provider reads -------------------------------------------------------------

  async listProviders(
    principal: AuthPrincipal,
    filter: ListProvidersFilter = {},
  ): Promise<{ items: readonly ProviderView[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.providerListSpec);
    const { rows, policy } = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      const predicates: SQL[] = [];
      if (filter.channelId) predicates.push(eq(schema.providers.channelId, filter.channelId));
      if (filter.status) predicates.push(eq(schema.providers.status, filter.status));
      if (resolved.after) predicates.push(resolved.after);
      const rows = await tx
        .select({ provider: schema.providers, channelCode: schema.channels.code })
        .from(schema.providers)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.providers.channelId))
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
      return { rows, policy: await loadCircuitPolicy(tx) };
    });
    const flat = rows.map((r) => ({ ...r.provider, channelCode: r.channelCode }));
    const { items, page } = this.lists.paginate(
      flat as unknown as Record<string, unknown>[],
      resolved,
      this.providerListSpec,
      (row) => String(row.id),
    );
    return {
      items: items.map((row) => {
        const r = row as unknown as ProviderRow & { channelCode: ChannelCode };
        return providerView(r, r.channelCode, policy);
      }),
      page,
    };
  }

  async getProvider(principal: AuthPrincipal, id: string): Promise<ProviderDetailView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      return providerDetail(tx, await loadProvider(tx, id));
    });
  }

  // --- provider mutations -----------------------------------------------------------

  /**
   * Creates a provider, `disabled`.
   *
   * **Naturally idempotent, not keyed** (ADR-013 2.1 notes; `API.md` §4a). The
   * canonical `Idempotency-Key` mechanism stores its record in an organization's
   * namespace (`idempotency_keys.org_id NOT NULL`, RLS by organization), and the
   * catalogue has no organization; giving it one would change a Phase 1 table and
   * its proofs, which 2.1 does not do. The provider's natural key — one name per
   * channel, case-insensitively — already makes a second side effect impossible.
   * A retried or duplicate create therefore changes nothing and answers `409
   * RESOURCE_CONFLICT` naming the provider that exists (`details.providerId`), so
   * a client retrying after a timeout can recognize and fetch what it created.
   * `INSERT … ON CONFLICT DO NOTHING` keeps that answer exact under concurrency:
   * the loser waits for the winner, inserts nothing, and reads the winner's row.
   */
  async create(principal: AuthPrincipal, input: CreateProviderDto): Promise<ProviderDetailView> {
    return this.committed(
      'create',
      this.db.withRequestTenant(async (tx) => {
        await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
        if (!(PROVIDER_ADAPTER_KEYS as readonly string[]).includes(input.adapterKey)) {
          throw new AppException({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
            message: 'adapterKey does not name a registered adapter',
            // The registered keys are part of the published contract.
            details: { adapterKeys: [...PROVIDER_ADAPTER_KEYS] },
          });
        }
        const [channel] = await tx
          .select()
          .from(schema.channels)
          .where(eq(schema.channels.id, input.channelId));
        if (!channel) throw notFound('Channel', input.channelId);

        const [row] = await tx
          .insert(schema.providers)
          .values({ channelId: channel.id, name: input.name, adapterKey: input.adapterKey })
          .onConflictDoNothing()
          .returning();
        if (!row) {
          const [existing] = await tx
            .select({ id: schema.providers.id })
            .from(schema.providers)
            .where(
              and(
                eq(schema.providers.channelId, channel.id),
                sql`lower(${schema.providers.name}) = lower(${input.name})`,
              ),
            );
          throw new AppException({
            status: HttpStatus.CONFLICT,
            code: ERROR_CODES.RESOURCE_CONFLICT,
            message: 'A provider with this name already exists on the channel',
            // Only a principal already authorized to administer this global
            // catalogue (`providers.manage` at platform) reaches this line, and the
            // conflict itself already reveals that the name is taken.
            ...(existing ? { details: { providerId: existing.id } } : {}),
          });
        }
        const view = providerView(row, channel.code, await loadCircuitPolicy(tx));
        await this.access.record(tx, principal, AUDIT_ACTIONS.PROVIDER_CREATED, view.id, null, {
          ...view,
        });
        return { ...view, capabilities: [] };
      }),
    );
  }

  /** Renames a provider. An unchanged or absent name changes nothing and records nothing. */
  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateProviderDto,
  ): Promise<ProviderDetailView> {
    return this.committed(
      'update',
      this.db.withRequestTenant(async (tx) => {
        await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
        const before = await loadProvider(tx, id, { forUpdate: true });
        if (input.name === undefined || input.name === before.name)
          return providerDetail(tx, before);

        const row = await this.writeUnique(() =>
          tx
            .update(schema.providers)
            .set({ name: input.name })
            .where(eq(schema.providers.id, id))
            .returning(),
        );
        await this.access.record(
          tx,
          principal,
          AUDIT_ACTIONS.PROVIDER_UPDATED,
          id,
          { name: before.name },
          { name: row.name },
        );
        return providerDetail(tx, row);
      }),
    );
  }

  /**
   * Replaces the capability set as a whole. Naturally idempotent: re-applying
   * the same set converges on the same state and records nothing the second
   * time.
   */
  async replaceCapabilities(
    principal: AuthPrincipal,
    id: string,
    input: ReplaceProviderCapabilitiesDto,
  ): Promise<ProviderDetailView> {
    const next = normalizeCapabilities(input.capabilities);
    return this.committed(
      'capabilities',
      this.db.withRequestTenant(async (tx) => {
        await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
        const provider = await loadProvider(tx, id, { forUpdate: true });
        const before = await readCapabilities(tx, id);
        if (sameCapabilities(before, next)) return providerDetail(tx, provider);

        await tx
          .delete(schema.providerCapabilities)
          .where(eq(schema.providerCapabilities.providerId, id));
        if (next.length > 0) {
          await tx
            .insert(schema.providerCapabilities)
            .values(next.map((c) => ({ providerId: id, capabilityKey: c.key, value: c.value })));
        }
        await this.access.record(
          tx,
          principal,
          AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED,
          id,
          { capabilities: before },
          { capabilities: next },
        );
        return providerDetail(tx, provider);
      }),
    );
  }

  /**
   * `enable`, `disable` or `drain` (ADR-013 F-5). The row is locked before its
   * status is read, so two concurrent transitions serialize and the second sees
   * the first's result; an illegal transition changes nothing and is a `409`
   * carrying the current status. A lifecycle transition never touches health or
   * circuit state (`PROVIDER_ADAPTER.md` §5.0).
   */
  async transition(
    principal: AuthPrincipal,
    id: string,
    transition: ProviderTransition,
  ): Promise<ProviderDetailView> {
    const rule = PROVIDER_TRANSITIONS[transition];
    return this.committed(
      transition,
      this.db.withRequestTenant(async (tx) => {
        await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
        const before = await loadProvider(tx, id, { forUpdate: true });
        if (!(rule.from as readonly ProviderStatus[]).includes(before.status)) {
          throw lifecycleConflict(before.status);
        }
        const [row] = await tx
          .update(schema.providers)
          .set({ status: rule.to })
          .where(eq(schema.providers.id, id))
          .returning();
        await this.access.record(
          tx,
          principal,
          TRANSITION_ACTIONS[transition],
          id,
          { status: before.status },
          { status: row!.status },
        );
        return providerDetail(tx, row!);
      }),
    );
  }

  // --- test-send (Phase 2.2; circuit breaker, Phase 2.3) ---------------------------------

  /**
   * Sends one synthetic submission through the provider's adapter and returns
   * the normalized answer (ADR-013 PD-3, ROADMAP §5b 2.2). Persists no message.
   *
   * Three steps, deliberately split so no database transaction is held open
   * across the adapter's wait (up to the platform timeout):
   *
   *   1. In a transaction, in the fixed precedence of `PROVIDER_ADAPTER.md`
   *      §6f: `providers.test_send` at platform scope; the provider, locked;
   *      only an `active` provider is a submission target — `disabled` and
   *      `draining` are `409` and never consult the circuit; its adapter comes
   *      from **its catalogue row**, resolved through the code registry, and an
   *      unregistered key fails closed (`422`); then **circuit admission**
   *      (§6c). A refusal calls no adapter and is recorded as a short-circuited
   *      `provider.test_sent` (`failure`) before the `409`.
   *   2. The submission, outside any transaction, under the executor's timeout.
   *   3. In a transaction: the permission again, fresh from the database, then
   *      the sample and its circuit and health effects (§6d) and
   *      `provider.test_sent` — the behaviour, outcome, category and latency,
   *      never a payload.
   *
   * A provider's rejection (`500`, `429`, a timeout …) is the *result* of a
   * successful test-send and is answered `200` with `outcome: "rejected"`.
   */
  async testSend(
    principal: AuthPrincipal,
    id: string,
    behavior: SimulatorBehavior,
  ): Promise<ProviderTestSendView> {
    const gate = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      const provider = await loadProvider(tx, id, { forUpdate: true });
      if (provider.status !== 'active') throw lifecycleConflict(provider.status);
      const adapter = this.simulatorFor(provider);
      const admission = await this.state.admit(tx, principal, provider);
      if (!admission.admitted) {
        await this.access.record(
          tx,
          principal,
          AUDIT_ACTIONS.PROVIDER_TEST_SENT,
          id,
          null,
          {
            behavior,
            outcome: 'short_circuited',
            circuitState: admission.state,
            category: null,
            retryable: null,
            latencyMs: null,
            submissionId: null,
          },
          'failure',
        );
        return { admission } as const;
      }
      const capabilities = await readCapabilities(tx, provider.id);
      return {
        admission,
        provider,
        adapter,
        channel: await channelCodeOf(tx, provider.channelId),
        capabilities: Object.fromEntries(capabilities.map((c) => [c.key, c.value])),
      } as const;
    });
    if (!gate.admission.admitted) throw circuitOpen(gate.admission);
    const { provider, adapter, channel, capabilities } = gate as Required<typeof gate>;
    const ticket = gate.admission.ticket;

    const correlationId = RequestContext.correlationId();
    const submission = {
      submissionId: uuidv7(),
      correlationId,
      channel,
      recipient: 'simulator:test-recipient',
      content: { text: 'ACC provider test-send' },
    };
    // Circuit admission is mandatory and redeemed by the executor before the
    // adapter is called (PROVIDER_ADAPTER.md §6h).
    const result = await this.executor.execute(
      gate.admission.admission,
      adapter.forBehavior(behavior),
      { providerId: provider.id, adapterKey: provider.adapterKey, channel, capabilities },
      submission,
      PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
    );

    const recorded = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      await this.access.assertAuthorityCurrent(tx, PERMISSIONS.PROVIDERS_TEST_SEND, {
        reason: 'authority withdrawn while the test-send ran; result not recorded',
        submissionId: submission.submissionId,
      });
      const states = await this.state.recordSubmission(tx, principal, provider.id, ticket, result);
      await this.access.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_TEST_SENT,
        provider.id,
        null,
        {
          behavior,
          outcome: result.outcome,
          category: result.outcome === 'rejected' ? result.failure.category : null,
          retryable: result.outcome === 'rejected' ? result.failure.retryable : null,
          latencyMs: result.latencyMs,
          submissionId: submission.submissionId,
          circuitProbe: ticket.probeId !== null,
          circuitState: states.circuitState,
          healthState: states.healthState,
        },
        testSendAuditOutcome(result.outcome),
      );
      return states;
    });

    const view: ProviderTestSendView = {
      providerId: provider.id,
      adapterKey: provider.adapterKey,
      channelCode: channel,
      behavior,
      submissionId: submission.submissionId,
      correlationId,
      outcome: result.outcome,
      providerMessageId: result.outcome === 'accepted' ? result.providerMessageId : null,
      failure: result.outcome === 'rejected' ? result.failure : null,
      latencyMs: result.latencyMs,
      circuitProbe: ticket.probeId !== null,
      healthState: recorded.healthState,
      circuitState: recorded.circuitState,
    };

    // Diagnostics only: no recipient, content or credential is logged.
    this.logger.log({
      msg: 'provider test-send',
      providerId: view.providerId,
      adapterKey: view.adapterKey,
      channel: view.channelCode,
      behavior,
      outcome: view.outcome,
      category: view.failure?.category ?? null,
      latencyMs: view.latencyMs,
      circuitProbe: view.circuitProbe,
      circuitState: view.circuitState,
      healthState: view.healthState,
      submissionId: view.submissionId,
      correlationId,
    });
    return view;
  }

  /**
   * The provider's adapter, from its catalogue row through the code registry —
   * never from the request. An unregistered key fails closed (`422`), and only
   * the simulator accepts a behaviour.
   */
  simulatorFor(provider: ProviderRow): SimulatorAdapter {
    let adapter;
    try {
      adapter = this.adapters.resolve(provider.adapterKey);
    } catch (error) {
      if (!(error instanceof ProviderAdapterNotRegistered)) throw error;
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
        message: "The provider's adapter is not registered",
        details: { adapterKeys: [...this.adapters.keys()] },
        logContext: { providerId: provider.id, adapterKey: provider.adapterKey },
      });
    }
    // The behaviour selects a simulator scenario; only the simulator takes one.
    if (!(adapter instanceof SimulatorAdapter)) {
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'A simulator behaviour can only be sent to a simulator provider',
      });
    }
    return adapter;
  }

  // --- internals -----------------------------------------------------------------------

  /** Runs a single-row write, mapping the per-channel name uniqueness to a `409`. */
  private async writeUnique(write: () => Promise<ProviderRow[]>): Promise<ProviderRow> {
    try {
      const [row] = await write();
      return row!;
    } catch (error) {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      if (cause?.code === '23505' && cause.constraint === 'providers_channel_name_key') {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'A provider with this name already exists on the channel',
        });
      }
      throw error;
    }
  }
}

/**
 * Validates a capability set beyond its DTO shape: unique keys, no key naming
 * secret material, and a bounded serialized value. Returned sorted by key so a
 * set compares and records deterministically.
 */
function normalizeCapabilities(input: readonly ProviderCapabilityDto[]): ProviderCapabilityView[] {
  const issues: { field: string; rule: string; message: string }[] = [];
  const seen = new Set<string>();
  input.forEach((capability, index) => {
    const field = `capabilities.${index}`;
    if (seen.has(capability.key)) {
      issues.push({ field, rule: 'DUPLICATE_KEY', message: 'capability keys must be unique' });
    }
    seen.add(capability.key);
    if (PROVIDER_CAPABILITY_FORBIDDEN_KEY_FRAGMENTS.some((f) => capability.key.includes(f))) {
      issues.push({
        field,
        rule: 'SECRET_KEY_FORBIDDEN',
        message: 'capabilities are non-secret; credential material is never stored here',
      });
    }
    const serialized = JSON.stringify(capability.value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, 'utf8') > PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES
    ) {
      issues.push({
        field,
        rule: 'VALUE_TOO_LARGE',
        message: `value must be JSON of at most ${PROVIDER_CAPABILITY_LIMITS.MAX_VALUE_BYTES} bytes`,
      });
    }
  });
  if (issues.length > 0) {
    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'The capability set is not valid',
      details: { issues },
    });
  }
  return [...input]
    .map((c) => ({ key: c.key, value: c.value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function sameCapabilities(
  a: readonly ProviderCapabilityView[],
  b: readonly ProviderCapabilityView[],
): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.key === b[i]!.key && canonicalJson(c.value) === canonicalJson(b[i]!.value))
  );
}

/** JSON with object keys sorted, so `jsonb`'s key reordering does not read as a change. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * A test-send's audit outcome (ADR-013 2.2 notes (f), revised at the Gate D.2
 * review), in the audit trail's established sense: `success` — the operation
 * was authorized and achieved its purpose; `failure` — it was authorized and
 * attempted but did not; `denied` — authorization refused it before it ran
 * (written by `AuthorizationService`, never here). A test-send's purpose is a
 * submission the provider accepts, so `accepted` is `success` (`SUCCESS`,
 * `SLOW_RESPONSE`) and every `rejected` answer is `failure` (`500`, `429`,
 * `TIMEOUT`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, and any adapter error).
 * A submission the circuit refused (Phase 2.3) is `failure` too.
 */
export function testSendAuditOutcome(outcome: 'accepted' | 'rejected'): 'success' | 'failure' {
  return outcome === 'accepted' ? 'success' : 'failure';
}

/** The circuit refused the submission (`PROVIDER_ADAPTER.md` §6c). */
function circuitOpen(refusal: Extract<Admission, { admitted: false }>): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.PROVIDER_CIRCUIT_OPEN,
    message:
      refusal.state === 'open'
        ? "This provider's circuit is open; the submission was not sent"
        : "This provider's circuit is half-open and its probe is in flight; the submission was not sent",
    // Readable through `GET /providers/:id`, so naming it discloses nothing.
    details: {
      circuitState: refusal.state,
      ...(refusal.retryAfterMs !== null ? { retryAfterMs: refusal.retryAfterMs } : {}),
    },
  });
}
