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
  type ChannelStatus,
  type PageInfo,
  type PermissionKey,
  type ProviderCircuitState,
  type ProviderHealthState,
  type ProviderStatus,
  type ProviderTransition,
  type ProviderFailure,
  type SimulatorBehavior,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
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
import type {
  CreateProviderDto,
  ProviderCapabilityDto,
  ReplaceProviderCapabilitiesDto,
  UpdateProviderDto,
} from './provider.dto';

/** The channel resource (`FRONTEND_API_CONTRACT.md` §32a). Exhaustive. */
export interface ChannelView {
  readonly id: string;
  readonly code: ChannelCode;
  readonly displayName: string;
  readonly status: ChannelStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The provider resource (`FRONTEND_API_CONTRACT.md` §32b). Exhaustive. */
export interface ProviderView {
  readonly id: string;
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  readonly name: string;
  readonly adapterKey: string;
  readonly status: ProviderStatus;
  /** Read-only in 2.1; the health mechanism arrives in 2.3. */
  readonly healthState: ProviderHealthState;
  /** Read-only in 2.1; the circuit breaker arrives in 2.3. */
  readonly circuitState: ProviderCircuitState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderCapabilityView {
  readonly key: string;
  readonly value: unknown;
}

/** `GET /providers/:id` and every mutation answer: the provider with its capability set. */
export interface ProviderDetailView extends ProviderView {
  readonly capabilities: readonly ProviderCapabilityView[];
}

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
}

export interface ListProvidersFilter extends ListQueryInput {
  readonly channelId?: string;
  readonly status?: ProviderStatus;
}

type ChannelRow = typeof schema.channels.$inferSelect;
type ProviderRow = typeof schema.providers.$inferSelect;

/** Every catalogue decision is made at platform scope (ADR-013 F-3). */
const PLATFORM = { scopeType: 'platform', scopeId: null } as const;

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
 * `AuthorizationService.assert` inside the request's transaction, which also
 * puts every mutation inside the Gate C pre-commit coverage boundary — and,
 * beneath that, RLS admits only a transaction whose user holds a validated
 * platform-scope grant (`app_has_platform_scope()`, migration `0018`). The
 * request's selected organization, if any, attributes a refusal in the audit
 * trail and nothing else: it is neither a target nor an authority here.
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
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly adapters: ProviderAdapterRegistry,
    private readonly executor: ProviderSubmissionExecutor,
  ) {}

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

  // --- authorization ----------------------------------------------------------

  /**
   * The route's permission at platform scope, decided by `AuthorizationService`
   * — the only authority. Called first in every operation's transaction.
   *
   * Every refusal goes through `assert` and its `authorization.denied` row — a
   * platform-scope principal without the permission (`alendei_support`, with or
   * without `X-Acc-Organization`) is filed at `platform` (migration `0019`).
   *
   * One case cannot be: a principal with **no** organization in context, **no**
   * reseller grant and **no** platform-scope grant — for example a member of
   * several organizations calling without `X-Acc-Organization`. There is no scope
   * its refusal could be filed under (ADR-005 D-6 files a denial at the actor's
   * own scope, and it has none here), so `AuthorizationService.recordDenial`
   * would fail with a `500`. Such a principal can never hold a platform-scope
   * permission — platform coverage requires a platform-scope grant — so it is
   * refused here: the same `403`, logged at `warn` with the correlation id by
   * `AllExceptionsFilter`, and the check recorded so route coverage holds. This
   * path only ever refuses; the non-auditing `allows` is asked as well, so a
   * principal the evaluator permits can never be refused here (ADR-013 F-3).
   */
  private async authorize(
    tx: Transaction,
    principal: AuthPrincipal,
    permission: PermissionKey,
  ): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    const attributable = Boolean(orgId || resellerId || hasPlatformGrant);
    if (
      !attributable &&
      !(await this.authorization.allows(tx, {
        principal,
        permission,
        target: PLATFORM,
        resourceType: 'Provider',
      }))
    ) {
      RequestContext.recordAuthorizationCheck(permission);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: {
          permission,
          targetScopeType: 'platform',
          reason:
            'refused; no organization, reseller or platform scope to attribute the refusal to',
        },
      });
    }
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: PLATFORM,
      resourceType: 'Provider',
    });
    // Defensive: the catalogue is administered by signed-in users. An API key
    // is organization-bound and cannot hold platform authority, so the assertion
    // above refuses it; this keeps that true if the evaluator ever changes.
    if (principal.actorType !== 'user' || !principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission, targetScopeType: 'platform', reason: 'not a signed-in user' },
      });
    }
  }

  // --- channels -----------------------------------------------------------------

  async listChannels(
    principal: AuthPrincipal,
    filter: ListQueryInput = {},
  ): Promise<{ items: readonly ChannelView[]; page: PageInfo }> {
    const resolved = this.lists.resolve(filter, this.channelListSpec);
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
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
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
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
    const rows = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      const predicates: SQL[] = [];
      if (filter.channelId) predicates.push(eq(schema.providers.channelId, filter.channelId));
      if (filter.status) predicates.push(eq(schema.providers.status, filter.status));
      if (resolved.after) predicates.push(resolved.after);
      return tx
        .select({ provider: schema.providers, channelCode: schema.channels.code })
        .from(schema.providers)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.providers.channelId))
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(...resolved.orderBy)
        .limit(this.lists.fetchSize(resolved));
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
        return providerView(r, r.channelCode);
      }),
      page,
    };
  }

  async getProvider(principal: AuthPrincipal, id: string): Promise<ProviderDetailView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_READ);
      return this.detail(tx, await this.load(tx, id));
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
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
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
      const view = providerView(row, channel.code);
      await this.record(tx, principal, AUDIT_ACTIONS.PROVIDER_CREATED, view.id, null, {
        ...view,
      });
      return { ...view, capabilities: [] };
    });
  }

  /** Renames a provider. An unchanged or absent name changes nothing and records nothing. */
  async update(
    principal: AuthPrincipal,
    id: string,
    input: UpdateProviderDto,
  ): Promise<ProviderDetailView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const before = await this.load(tx, id, { forUpdate: true });
      if (input.name === undefined || input.name === before.name) return this.detail(tx, before);

      const row = await this.writeUnique(() =>
        tx
          .update(schema.providers)
          .set({ name: input.name })
          .where(eq(schema.providers.id, id))
          .returning(),
      );
      await this.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_UPDATED,
        id,
        { name: before.name },
        { name: row.name },
      );
      return this.detail(tx, row);
    });
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
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const provider = await this.load(tx, id, { forUpdate: true });
      const before = await this.capabilities(tx, id);
      if (sameCapabilities(before, next)) return this.detail(tx, provider);

      await tx
        .delete(schema.providerCapabilities)
        .where(eq(schema.providerCapabilities.providerId, id));
      if (next.length > 0) {
        await tx
          .insert(schema.providerCapabilities)
          .values(next.map((c) => ({ providerId: id, capabilityKey: c.key, value: c.value })));
      }
      await this.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_CAPABILITIES_REPLACED,
        id,
        { capabilities: before },
        { capabilities: next },
      );
      return this.detail(tx, provider);
    });
  }

  /**
   * `enable`, `disable` or `drain` (ADR-013 F-5). The row is locked before its
   * status is read, so two concurrent transitions serialize and the second sees
   * the first's result; an illegal transition changes nothing and is a `409`
   * carrying the current status.
   */
  async transition(
    principal: AuthPrincipal,
    id: string,
    transition: ProviderTransition,
  ): Promise<ProviderDetailView> {
    const rule = PROVIDER_TRANSITIONS[transition];
    return this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      const before = await this.load(tx, id, { forUpdate: true });
      if (!(rule.from as readonly ProviderStatus[]).includes(before.status)) {
        throw lifecycleConflict(before.status);
      }
      const [row] = await tx
        .update(schema.providers)
        .set({ status: rule.to })
        .where(eq(schema.providers.id, id))
        .returning();
      await this.record(
        tx,
        principal,
        TRANSITION_ACTIONS[transition],
        id,
        { status: before.status },
        { status: row!.status },
      );
      return this.detail(tx, row!);
    });
  }

  // --- test-send (Phase 2.2) ----------------------------------------------------------

  /**
   * Sends one synthetic submission through the provider's adapter and returns
   * the normalized answer (ADR-013 PD-3, ROADMAP §5b 2.2). Persists no message.
   *
   * Three steps, deliberately split so no database transaction is held open
   * across the adapter's wait (up to the platform timeout):
   *
   *   1. In a transaction: `providers.test_send` at platform scope, then the
   *      provider. Only an `active` provider is a submission target — `disabled`
   *      and `draining` are `409` — and its adapter comes from **its catalogue
   *      row**, resolved through the code registry; an unregistered key fails
   *      closed (`422`). Nothing the caller sends names an adapter.
   *   2. The submission, outside any transaction, under the executor's timeout.
   *   3. In a transaction: the permission again, then `provider.test_sent` —
   *      the behaviour, outcome, category and latency, never a payload.
   *
   * A provider's rejection (`500`, `429`, a timeout …) is the *result* of a
   * successful test-send and is answered `200` with `outcome: "rejected"`.
   */
  async testSend(
    principal: AuthPrincipal,
    id: string,
    behavior: SimulatorBehavior,
  ): Promise<ProviderTestSendView> {
    const target = await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      const provider = await this.load(tx, id);
      if (provider.status !== 'active') throw lifecycleConflict(provider.status);
      const [channel] = await tx
        .select({ code: schema.channels.code })
        .from(schema.channels)
        .where(eq(schema.channels.id, provider.channelId));
      const capabilities = await this.capabilities(tx, provider.id);
      return {
        provider,
        channel: channel!.code,
        capabilities: Object.fromEntries(capabilities.map((c) => [c.key, c.value])),
      };
    });

    let adapter;
    try {
      adapter = this.adapters.resolve(target.provider.adapterKey);
    } catch (error) {
      if (!(error instanceof ProviderAdapterNotRegistered)) throw error;
      throw new AppException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: ERROR_CODES.PROVIDER_ADAPTER_UNKNOWN,
        message: "The provider's adapter is not registered",
        details: { adapterKeys: [...this.adapters.keys()] },
        logContext: { providerId: id, adapterKey: target.provider.adapterKey },
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

    const correlationId = RequestContext.correlationId();
    const submission = {
      submissionId: uuidv7(),
      correlationId,
      channel: target.channel,
      recipient: 'simulator:test-recipient',
      content: { text: 'ACC provider test-send' },
    };
    const result = await this.executor.execute(
      adapter.forBehavior(behavior),
      {
        providerId: target.provider.id,
        adapterKey: target.provider.adapterKey,
        channel: target.channel,
        capabilities: target.capabilities,
      },
      submission,
      PROVIDER_SUBMISSION_DEFAULTS.TIMEOUT_MS,
    );

    const view: ProviderTestSendView = {
      providerId: target.provider.id,
      adapterKey: target.provider.adapterKey,
      channelCode: target.channel,
      behavior,
      submissionId: submission.submissionId,
      correlationId,
      outcome: result.outcome,
      providerMessageId: result.outcome === 'accepted' ? result.providerMessageId : null,
      failure: result.outcome === 'rejected' ? result.failure : null,
      latencyMs: result.latencyMs,
    };

    await this.db.withRequestTenant(async (tx) => {
      await this.authorize(tx, principal, PERMISSIONS.PROVIDERS_TEST_SEND);
      await this.assertAuthorityCurrent(tx, PERMISSIONS.PROVIDERS_TEST_SEND, view.submissionId);
      await this.record(
        tx,
        principal,
        AUDIT_ACTIONS.PROVIDER_TEST_SENT,
        view.providerId,
        null,
        {
          behavior,
          outcome: view.outcome,
          category: view.failure?.category ?? null,
          retryable: view.failure?.retryable ?? null,
          latencyMs: view.latencyMs,
          submissionId: view.submissionId,
        },
        testSendAuditOutcome(view.outcome),
      );
    });

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
      submissionId: view.submissionId,
      correlationId,
    });
    return view;
  }

  /**
   * The actor's authority **as the database holds it now**, not as it stood
   * when the request was authenticated.
   *
   * `AuthorizationService.assert` evaluates the grants `AuthGuard` resolved at
   * the start of the request. For test-send that snapshot is up to a submission
   * timeout old by the second transaction, so the audit write is gated on a
   * fresh read as well: `app_has_platform_permission`, the same predicate the
   * `provider.test_sent` RLS policy applies (migration `0020`). If the grant was
   * revoked or the user disabled while the submission ran, the request ends
   * with a `403` and no audit row — rather than an RLS refusal surfacing as a
   * `500`. The submission itself was authorized when it started; its result is
   * neither returned nor recorded.
   */
  private async assertAuthorityCurrent(
    tx: Transaction,
    permission: PermissionKey,
    submissionId: string,
  ): Promise<void> {
    const { rows } = await tx.execute<{ allowed: boolean }>(
      sql`select app_has_platform_permission(${permission}) as allowed`,
    );
    if (rows[0]?.allowed === true) return;
    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message: 'You do not have permission to perform this action',
      logContext: {
        permission,
        targetScopeType: 'platform',
        reason: 'authority withdrawn while the test-send ran; result not recorded',
        submissionId,
      },
    });
  }

  // --- internals -----------------------------------------------------------------------

  private async load(
    tx: Transaction,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<ProviderRow> {
    const query = tx.select().from(schema.providers).where(eq(schema.providers.id, id));
    const [row] = options.forUpdate ? await query.for('update') : await query;
    if (!row) throw notFound('Provider', id);
    return row;
  }

  private async detail(tx: Transaction, row: ProviderRow): Promise<ProviderDetailView> {
    const [channel] = await tx
      .select({ code: schema.channels.code })
      .from(schema.channels)
      .where(eq(schema.channels.id, row.channelId));
    return {
      ...providerView(row, channel!.code),
      capabilities: await this.capabilities(tx, row.id),
    };
  }

  private async capabilities(
    tx: Transaction,
    providerId: string,
  ): Promise<ProviderCapabilityView[]> {
    const rows = await tx
      .select({
        key: schema.providerCapabilities.capabilityKey,
        value: schema.providerCapabilities.value,
      })
      .from(schema.providerCapabilities)
      .where(eq(schema.providerCapabilities.providerId, providerId))
      .orderBy(asc(schema.providerCapabilities.capabilityKey));
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }

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

  /**
   * The audit row, in the mutation's own transaction (every provider action is
   * security-sensitive, ADR-013 F-4), at `platform` scope — the scope the
   * decision was made at. Nothing secret can reach it: the catalogue holds no
   * credential, and capability keys that would name one are refused.
   */
  private record(
    tx: Transaction,
    principal: AuthPrincipal,
    action: AuditAction,
    providerId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'Provider',
        resourceId: providerId,
        outcome,
        before,
        after,
        metadata: {},
      },
      tx,
    );
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
 */
export function testSendAuditOutcome(outcome: 'accepted' | 'rejected'): 'success' | 'failure' {
  return outcome === 'accepted' ? 'success' : 'failure';
}

function lifecycleConflict(status: ProviderStatus): AppException {
  return new AppException({
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.PROVIDER_LIFECYCLE_CONFLICT,
    message: `This provider is ${status}; the operation is not permitted in that state`,
    // Readable through `GET /providers/:id`, so naming it discloses nothing.
    details: { status },
  });
}

function notFound(resource: 'Provider' | 'Channel', id: string): AppException {
  return new AppException({
    status: HttpStatus.NOT_FOUND,
    code: ERROR_CODES.RESOURCE_NOT_FOUND,
    message: `${resource} not found`,
    logContext: { [`requested${resource}Id`]: id },
  });
}

function channelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    code: row.code,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function providerView(row: ProviderRow, channelCode: ChannelCode): ProviderView {
  return {
    id: row.id,
    channelId: row.channelId,
    channelCode,
    name: row.name,
    adapterKey: row.adapterKey,
    status: row.status,
    healthState: row.healthState,
    circuitState: row.circuitState,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
