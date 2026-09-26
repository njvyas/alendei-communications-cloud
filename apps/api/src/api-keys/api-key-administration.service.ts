import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type AuthPrincipal,
  type PageInfo,
  type ScopeRef,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, isNotNull, or, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppConfigService } from '../config/app-config.service';
import { CredentialService } from '../iam/credential.service';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { assertScopeAcceptsNewMembers } from '../tenancy/scope-lifecycle';
import { mintApiKey } from './api-key-secret';
import type { ApiKeyScopeType, ApiKeyStatus } from './api-key.dto';

/**
 * The API key as the control plane presents it. **Metadata only.**
 *
 * `key_hash` is absent and unreachable: the projection below never selects it,
 * so no read path can return it by accident. The plaintext secret is not a
 * column at all — it exists for the duration of one creation response and is
 * then gone (ADR-008).
 */
export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  /** Public half of the credential. Identifies the key; verifies nothing. */
  readonly prefix: string;
  /** Derived, never stored — see `statusOf`. */
  readonly status: ApiKeyStatus;
  readonly scopeType: ApiKeyScopeType;
  readonly scopeId: string;
  readonly orgId: string;
  /** The permission subset requested at creation, not the effective set. */
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A freshly created key: the resource, plus the plaintext secret.
 *
 * The two are returned as **separate fields of one object** rather than the
 * secret being folded into the view, so that a caller has to decide
 * deliberately where the plaintext goes. `ApiKeyView` alone is always safe to
 * persist, log or replay; `secret` never is (ADR-008).
 */
export interface MintedApiKeyResult {
  readonly view: ApiKeyView;
  /** Plaintext. In memory only, for one response. */
  readonly secret: string;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopeType: ApiKeyScopeType;
  readonly scopeId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date | null;
}

/** Allow-listed filters for `GET /api-keys` (`API.md` §8b). */
export interface ListApiKeysFilter extends ListQueryInput {
  readonly status?: ApiKeyStatus;
  readonly scopeType?: ApiKeyScopeType;
  readonly scopeId?: string;
  readonly name?: string;
}

/** The reason recorded on an administrative revocation. */
const REVOKED_BY_ADMIN = 'revoked_by_administrator';

/**
 * API-key administration (Phase 1B.6.2, `API.md` §3e, `RBAC.md` §5c/§8d).
 *
 * This is the surface that mints credentials, so what it refuses to do matters
 * more than what it does.
 *
 * ---
 *
 * **It does not decide what a key may do.** A key's effective authority is its
 * requested `scopes` intersected with what its creator holds **at the key's
 * binding scope**, recomputed by `AuthGuard` on every request (ADR-005 D-4).
 * Nothing here caches, snapshots or widens that. Creation additionally refuses
 * a key asking for more than the creator holds there — through the same
 * `unheldPermissions` the role surfaces use, not a second algorithm — so the
 * caller gets a named refusal rather than a key that silently does less than it
 * asked for.
 *
 * **It does not invent a scope model.** A key binds to an organization or to a
 * workspace, because those are the two the credential path can express:
 * `api_keys.org_id` is `NOT NULL` and `workspace_id` is nullable, and
 * `AuthGuard` derives the grant scope from exactly that pair. Reseller, team and
 * platform bindings are unrepresentable in the DTO rather than rejected by a
 * check.
 *
 * **It does not store a lifecycle.** `status` is derived from `revoked_at`,
 * `expires_at` and the current time, at read and independently at
 * authentication. There is no status column, no sweeper and no second source of
 * truth: an expired key stops authenticating because `findApiKeyByPrefix`
 * filters it out, not because something marked it.
 *
 * **It never handles the secret after minting it.** The plaintext is produced,
 * hashed, and handed back to the caller in one object; only the Argon2id digest
 * reaches the database. It is never logged, never audited, never put in an
 * error, and never persisted into an idempotency snapshot (ADR-008).
 */
@Injectable()
export class ApiKeyAdministrationService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly credentials: CredentialService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly config: AppConfigService,
  ) {}

  /**
   * The list's ordering contract (`API.md` §8b).
   *
   * `-createdAt` by default: an administrator reading a key list is usually
   * asking what was issued recently. Chronological ordering runs on `id`, not
   * `created_at`, for the reason every other list here does — a cursor is text,
   * and a `timestamptz` round-tripped through JavaScript loses the database's
   * sub-millisecond precision, so the boundary would land before the row it was
   * minted from and the page would repeat forever. `id` is a UUIDv7.
   *
   * **`lastUsedAt`, `expiresAt` and `status` are deliberately not sortable.**
   * The first two are nullable, and keyset pagination over a nullable column has
   * no total order without explicit NULLS handling in both the `ORDER BY` and
   * the cursor predicate; offering them would mean a walk that can skip or
   * repeat rows. `status` is derived, so there is no column to order by at all.
   */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.apiKeys.id, encode: (row) => String(row.id) },
      name: { column: schema.apiKeys.name, encode: (row) => String(row.name) },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.apiKeys.id,
  };

  // --- reads -----------------------------------------------------------------

  async list(
    tx: Transaction,
    principal: AuthPrincipal,
    filter: ListApiKeysFilter = {},
  ): Promise<{ items: readonly ApiKeyView[]; page: PageInfo }> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'api_keys.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'API key',
    });

    const resolved = this.lists.resolve(filter, this.listSpec);

    // Pinned to the organization the list was authorized against; RLS
    // (`api_keys_tenant`) beneath it independently holds the tenant boundary if
    // this predicate is ever lost (Gate-B audit, Blocker 1).
    const predicates: SQL[] = [eq(schema.apiKeys.orgId, orgId)];
    if (filter.status) predicates.push(this.statusPredicate(filter.status));
    if (filter.scopeType) predicates.push(this.scopeTypePredicate(filter.scopeType));
    if (filter.scopeId) {
      predicates.push(
        or(
          eq(schema.apiKeys.workspaceId, filter.scopeId),
          and(isNull(schema.apiKeys.workspaceId), eq(schema.apiKeys.orgId, filter.scopeId)),
        )!,
      );
    }
    if (filter.name) predicates.push(eq(schema.apiKeys.name, filter.name));
    if (resolved.after) predicates.push(resolved.after);

    const rows = await tx
      .select(this.columns())
      .from(schema.apiKeys)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(...resolved.orderBy)
      .limit(this.lists.fetchSize(resolved));

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );

    return { items: items.map((row) => this.view(row as never)), page };
  }

  /**
   * One key, authorized against **its own stored binding scope**.
   *
   * Not against the request's organization: a key bound to a workspace is a
   * workspace resource, and an actor who covers the organization but not that
   * workspace should not read it merely because it is listed under the same
   * tenant. The scope comes from the row, never from the caller.
   */
  async get(tx: Transaction, principal: AuthPrincipal, id: string): Promise<ApiKeyView> {
    this.requireOrg(principal);
    const row = await this.loadVisible(tx, id);

    await this.authorization.assert(tx, {
      principal,
      permission: 'api_keys.read',
      target: this.bindingScopeOf(row),
      resourceType: 'API key',
    });

    return this.view(row);
  }

  // --- creation ---------------------------------------------------------------

  /**
   * The authorization `create` performs, exposed so the idempotent replay path
   * runs the same check against the same target.
   *
   * A replay does not run `create`, so without this a stored response would be
   * returned on the strength of a decision made during the original request.
   * One definition, called from both.
   */
  async assertMayCreate(
    tx: Transaction,
    principal: AuthPrincipal,
    target: ScopeRef,
  ): Promise<void> {
    this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'api_keys.create',
      target,
      resourceType: 'Scope',
    });
  }

  /**
   * Mints a key and returns its plaintext secret **once**.
   *
   * The order is deliberate: authorize at the requested binding scope, resolve
   * the binding from the database, refuse a request that exceeds the creator's
   * authority there, and only then generate any credential material. Nothing is
   * minted for a request that was going to be refused.
   */
  async create(
    tx: Transaction,
    principal: AuthPrincipal,
    input: CreateApiKeyInput,
  ): Promise<MintedApiKeyResult> {
    this.requireOrg(principal);
    const target: ScopeRef = { scopeType: input.scopeType, scopeId: input.scopeId };

    // 1 — may the actor create a key *here*. The target is the binding scope
    // being asked for, resolved through the database's own ancestry, so another
    // tenant's workspace is `404` rather than a confirmation that it exists.
    await this.authorization.assert(tx, {
      principal,
      permission: 'api_keys.create',
      target,
      resourceType: 'Scope',
    });

    // 2 — only a user may create a key, because only a user can be its creator.
    //
    // `api_keys.created_by` references `users`, and `AuthGuard` resolves a key
    // with no creator to *no permissions at all*. A key minted by another key
    // would therefore authenticate and be able to do nothing — a dead
    // credential that looks live. Refusing is the honest answer.
    const creatorId = principal.userId;
    if (principal.actorType !== 'user' || !creatorId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
        message: 'Only a signed-in user can create an API key',
        logContext: { actorType: principal.actorType },
      });
    }

    // 3 — the binding, read from the database rather than from the request.
    const binding = await this.resolveBinding(tx, input.scopeType, input.scopeId);

    // An archived workspace receives no new API keys (ADR-012 F-6).
    await assertScopeAcceptsNewMembers(tx, target);

    // 4 — the key may not ask for more than its creator holds at the binding
    // scope. The same question role composition asks, through the same boundary
    // method, resolving the chain once rather than once per permission.
    const unheld = await this.authorization.unheldPermissions(tx, {
      principal,
      permissions: input.scopes,
      target,
    });
    if (unheld.length > 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        message: 'This key requests a permission you do not hold at that scope',
        details: { rejected: [...unheld] },
      });
    }

    // 5 — expiry is compared against the database clock, not the caller's.
    const expiresAt = input.expiresAt ?? null;
    if (expiresAt) await this.assertFutureExpiry(tx, expiresAt);

    // 6 — credential material, generated only now that the request will succeed.
    const minted = mintApiKey(this.config.isProduction ? 'live' : 'test');
    const keyHash = await this.credentials.hash(minted.secret);

    const [row] = await tx
      .insert(schema.apiKeys)
      .values({
        orgId: binding.orgId,
        workspaceId: binding.workspaceId,
        name: input.name,
        keyPrefix: minted.prefix,
        keyHash,
        scopes: [...input.scopes],
        expiresAt,
        createdBy: creatorId,
      })
      .returning(this.columns());

    if (!row) throw new Error('api key: insert returned no row');
    const view = this.view(row as never);

    await this.audit.record(
      {
        // The scope the key is bound to: for a credential, where it may act is
        // the truthful statement of where it was created.
        scopeType: view.scopeType,
        scopeId: view.scopeId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.API_KEY_CREATED,
        resourceType: 'ApiKey',
        resourceId: view.id,
        outcome: 'success',
        before: null,
        // Identity and binding only. The prefix is public and is what an
        // operator correlates a later `api_key.authenticated` row against; the
        // secret and its digest appear nowhere.
        after: {
          name: view.name,
          prefix: view.prefix,
          scopeType: view.scopeType,
          scopeId: view.scopeId,
          expiresAt: view.expiresAt,
        },
        metadata: { scopes: view.scopes, createdBy: creatorId },
      },
      tx,
    );

    return { view, secret: minted.secret };
  }

  // --- revocation ---------------------------------------------------------------

  /**
   * Revokes a key. Terminal: there is no un-revoke, and no deletion.
   *
   * Authorized against **the key's stored binding scope**, read from the row —
   * never from anything the caller supplied. An actor that can see a key listed
   * at the organization still cannot revoke one bound to a workspace it does not
   * cover.
   *
   * The write is conditional (`WHERE revoked_at IS NULL`) rather than a
   * read-then-write, so two concurrent revocations of the same key produce
   * exactly one `200` and one `409` — the row lock decides it, not the order the
   * two requests happened to arrive in. That is the same shape
   * `RoleAssignmentService.revoke` uses for its conditional delete.
   */
  async revoke(tx: Transaction, principal: AuthPrincipal, id: string): Promise<ApiKeyView> {
    this.requireOrg(principal);
    const before = await this.loadVisible(tx, id);

    await this.authorization.assert(tx, {
      principal,
      permission: 'api_keys.revoke',
      target: this.bindingScopeOf(before),
      resourceType: 'API key',
    });

    const beforeView = this.view(before);
    if (beforeView.status === 'revoked') {
      throw this.lifecycleConflict('This API key is already revoked', beforeView.status);
    }

    const rows = await tx
      .update(schema.apiKeys)
      .set({ revokedAt: new Date(), revokedReason: REVOKED_BY_ADMIN, updatedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, id), isNull(schema.apiKeys.revokedAt)))
      .returning(this.columns());

    const row = rows[0];
    if (!row) {
      // A concurrent revocation won. Reporting the conflict is honest — the key
      // is revoked, just not by this request — and matches the lifecycle
      // convention Phase 1B.6.1 established for a transition that no longer
      // applies.
      throw this.lifecycleConflict('This API key is already revoked', 'revoked');
    }

    const after = this.view(row as never);

    await this.audit.record(
      {
        scopeType: after.scopeType,
        scopeId: after.scopeId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.API_KEY_REVOKED,
        resourceType: 'ApiKey',
        resourceId: after.id,
        outcome: 'success',
        before: { status: beforeView.status, prefix: beforeView.prefix },
        after: { status: after.status, revokedAt: after.revokedAt },
        metadata: { reason: REVOKED_BY_ADMIN },
      },
      tx,
    );

    return after;
  }

  // --- guards and helpers ---------------------------------------------------------

  private requireOrg(principal: AuthPrincipal): string {
    const orgId = principal.tenant.orgId;
    if (!orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }
    return orgId;
  }

  /**
   * The organization and workspace columns a binding resolves to.
   *
   * For a workspace binding the organization is read from `workspaces.org_id`,
   * never from the request or from the caller's context — the workspace's real
   * parent is the only thing that may decide which tenant owns the key. The read
   * runs under RLS, so a workspace in another tenant is invisible and resolves
   * to `404` exactly as the authorization check above already did.
   */
  private async resolveBinding(
    tx: Transaction,
    scopeType: ApiKeyScopeType,
    scopeId: string,
  ): Promise<{ orgId: string; workspaceId: string | null }> {
    if (scopeType === 'organization') {
      const [org] = await tx
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, scopeId));
      if (!org) throw this.notFound(scopeId, 'Organization');
      return { orgId: org.id, workspaceId: null };
    }

    const [workspace] = await tx
      .select({ id: schema.workspaces.id, orgId: schema.workspaces.orgId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, scopeId));
    if (!workspace) throw this.notFound(scopeId, 'Workspace');
    return { orgId: workspace.orgId, workspaceId: workspace.id };
  }

  /** Expiry judged by the database clock, so client skew cannot widen it. */
  private async assertFutureExpiry(tx: Transaction, expiresAt: Date): Promise<void> {
    const { rows } = await tx.execute<{ future: boolean }>(
      sql`SELECT ${expiresAt.toISOString()}::timestamptz > now() AS future`,
    );
    if (rows[0]?.future) return;

    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.VALIDATION_FAILED,
      message: 'Request validation failed',
      details: {
        issues: [
          {
            field: 'expiresAt',
            rule: 'MUST_BE_FUTURE',
            message: 'expiresAt must be in the future',
          },
        ],
      },
    });
  }

  private async loadVisible(tx: Transaction, id: string): Promise<ApiKeyRow> {
    const [row] = await tx
      .select(this.columns())
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));
    if (!row) throw this.notFound(id, 'API key');
    return row as unknown as ApiKeyRow;
  }

  /** The key's own binding, as an authorization target. Read from the row. */
  private bindingScopeOf(row: ApiKeyRow): ScopeRef {
    return row.workspaceId
      ? { scopeType: 'workspace', scopeId: row.workspaceId }
      : { scopeType: 'organization', scopeId: row.orgId };
  }

  private statusPredicate(status: ApiKeyStatus): SQL {
    if (status === 'revoked') return isNotNull(schema.apiKeys.revokedAt);
    if (status === 'expired') {
      return and(
        isNull(schema.apiKeys.revokedAt),
        isNotNull(schema.apiKeys.expiresAt),
        sql`${schema.apiKeys.expiresAt} <= now()`,
      )!;
    }
    return and(
      isNull(schema.apiKeys.revokedAt),
      or(isNull(schema.apiKeys.expiresAt), sql`${schema.apiKeys.expiresAt} > now()`),
    )!;
  }

  private scopeTypePredicate(scopeType: ApiKeyScopeType): SQL {
    return scopeType === 'workspace'
      ? isNotNull(schema.apiKeys.workspaceId)
      : isNull(schema.apiKeys.workspaceId);
  }

  private lifecycleConflict(message: string, status: ApiKeyStatus): AppException {
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.API_KEY_LIFECYCLE_CONFLICT,
      message,
      details: { status },
    });
  }

  private notFound(id: string, what: string): AppException {
    return new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: `${what} not found`,
      logContext: { requestedId: id },
    });
  }

  /**
   * The projection, written once.
   *
   * `key_hash` is not in it, and that is the defence: a bare `select()` on
   * `api_keys` returns the Argon2id digest, and the only reliable way to keep it
   * out of every read path is never to write one that could include it.
   */
  private columns() {
    return {
      id: schema.apiKeys.id,
      orgId: schema.apiKeys.orgId,
      workspaceId: schema.apiKeys.workspaceId,
      name: schema.apiKeys.name,
      keyPrefix: schema.apiKeys.keyPrefix,
      scopes: schema.apiKeys.scopes,
      expiresAt: schema.apiKeys.expiresAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      revokedAt: schema.apiKeys.revokedAt,
      revokedReason: schema.apiKeys.revokedReason,
      createdBy: schema.apiKeys.createdBy,
      createdAt: schema.apiKeys.createdAt,
      updatedAt: schema.apiKeys.updatedAt,
    };
  }

  /**
   * The lifecycle state, derived rather than stored.
   *
   * Revocation wins over expiry: a key that was revoked and has since passed its
   * expiry is `revoked`, because that is the fact an operator needs — someone
   * took it away. Both are terminal for authentication either way, and
   * `findApiKeyByPrefix` enforces the same two conditions independently, so this
   * is a *rendering* of state rather than the state itself.
   */
  private statusOf(row: ApiKeyRow, now: Date): ApiKeyStatus {
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return 'expired';
    return 'active';
  }

  private view(row: ApiKeyRow, now = new Date()): ApiKeyView {
    const scopeType: ApiKeyScopeType = row.workspaceId ? 'workspace' : 'organization';
    return {
      id: row.id,
      name: row.name,
      prefix: row.keyPrefix,
      status: this.statusOf(row, now),
      scopeType,
      scopeId: row.workspaceId ?? row.orgId,
      orgId: row.orgId,
      scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revokedReason: row.revokedReason,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

interface ApiKeyRow {
  id: string;
  orgId: string;
  workspaceId: string | null;
  name: string;
  keyPrefix: string;
  scopes: unknown;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
