import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  scopeCovers,
  type ActorType,
  type AuthPrincipal,
  type ScopeChain,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';

import { AppException } from '../common/errors/app.exception';
import { AuditWriter } from '../audit/audit-writer.service';
import { RequestContext } from '../common/context/request-context';
import { CredentialService } from '../iam/credential.service';
import { SessionService } from '../iam/session.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { TenantDatabase } from '../database/tenant-database.service';
import { AccessTokenService } from './jwt.service';
import { ORGANIZATION_HEADER, ScopeResolver } from './scope-resolver.service';
import { IS_PUBLIC, SKIP_TENANT } from './public.decorator';

/** How the principal proved who it is. Normalized across both mechanisms. */
export type AuthMethod = 'session' | 'api_key';

/** The principal, plus the request-scoped facts the audit trail needs. */
export interface ResolvedPrincipal extends AuthPrincipal {
  readonly authMethod: AuthMethod;
  /** `iat` of the presenting token, or the API key's own issue time. */
  readonly authenticatedAt: Date;
  /**
   * Every organization this principal may act in.
   *
   * Exposed so a console can offer an organization picker without guessing —
   * a multi-organization user must be able to discover what to put in
   * `X-Acc-Organization` before it can send one. It is derived from grants, so
   * listing it discloses nothing the principal could not already reach.
   */
  readonly authorizedOrganizationIds: readonly string[];
}

const BEARER = /^Bearer\s+(.+)$/i;
const API_KEY_SHAPE = /^(ak_(?:live|test)_[A-Za-z0-9]{16})\.(.+)$/;

/**
 * The single authentication boundary (`TENANCY.md` §2a).
 *
 * Resolves a credential into an `AuthPrincipal`, then derives tenancy from
 * **current database state** — never from the token. The whole chain runs here
 * so no handler can accidentally skip a step:
 *
 *   credential → identity → session/user state → grants → scope set →
 *   organization selection → TenantContext → RequestContext
 *
 * Registered globally and denying by default. The two things it refuses to do
 * are as important as what it does: it never reads tenancy from a claim, and it
 * never treats a validly-signed token as sufficient on its own — the session
 * must still exist, be unrevoked, unexpired, unrotated, and belong to an active
 * user, checked against PostgreSQL on every request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: TenantDatabase,
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionService,
    private readonly users: UserLifecycleService,
    private readonly credentials: CredentialService,
    private readonly scopes: ScopeResolver,
    private readonly audit: AuditWriter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const skipTenant =
      this.reflector.getAllAndOverride<boolean>(SKIP_TENANT, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false;

    const authorization = request.headers.authorization ?? '';
    const match = BEARER.exec(authorization);
    if (!match) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }

    const credential = match[1]!.trim();
    const requestedOrg = this.header(request, ORGANIZATION_HEADER);

    const principal = API_KEY_SHAPE.test(credential)
      ? await this.resolveApiKey(credential, requestedOrg)
      : await this.resolveSession(credential, requestedOrg, skipTenant);

    RequestContext.setPrincipal(principal);
    return true;
  }

  private header(request: Request, name: string): string | null {
    const value = request.headers[name];
    if (Array.isArray(value)) return value[0] ?? null;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  /** Session-JWT authentication. */
  private async resolveSession(
    token: string,
    requestedOrg: string | null,
    skipTenant: boolean,
  ): Promise<ResolvedPrincipal> {
    const claims = this.tokens.verify(token);

    return this.db.auth.transaction(async (raw) => {
      const tx = raw as Transaction;

      // A valid signature is not sufficient. The session is re-read every
      // request, so revocation takes effect immediately rather than at token
      // expiry — PostgreSQL remains the correctness boundary, and there is no
      // second session-state model anywhere.
      const session = await this.sessions.findById(tx, claims.sid);
      if (!session || session.userId !== claims.sub || !this.sessions.isPresentable(session)) {
        throw new AppException({
          status: HttpStatus.UNAUTHORIZED,
          code: ERROR_CODES.AUTH_SESSION_REVOKED,
          message: 'This session is no longer valid; sign in again',
        });
      }

      const user = await this.users.findById(tx, claims.sub);
      if (!user || !this.users.canAuthenticate(user)) {
        throw new AppException({
          status: HttpStatus.UNAUTHORIZED,
          code: ERROR_CODES.AUTH_ACCOUNT_DISABLED,
          message: 'This account cannot sign in',
        });
      }

      const scopes = await this.scopes.forUser(tx, user.id);
      const orgId = skipTenant ? null : this.scopes.selectOrganization(scopes, requestedOrg);
      const tenant = await this.scopes.tenantContextFor(tx, scopes, orgId);

      await this.sessions.touch(tx, session.id);

      return {
        actorType: 'user' as ActorType,
        userId: user.id,
        apiKeyId: null,
        sessionId: session.id,
        tenant,
        roles: scopes.grants,
        permissions: scopes.permissions,
        authMethod: 'session',
        authenticatedAt: new Date(claims.iat * 1000),
        authorizedOrganizationIds: scopes.organizationIds,
      };
    });
  }

  /**
   * API-key authentication.
   *
   * The key is permanently bound to one organization, so it selects no
   * organization and an `X-Acc-Organization` naming a different one is refused
   * rather than ignored. Its effective permissions are an intersection
   * (`RBAC.md` §5c) — the key's requested scopes ∩ what its creator actually
   * holds *now*. A scope string present on the key grants nothing on its own,
   * which is what stops a key outliving the authority that produced it.
   */
  private async resolveApiKey(
    credential: string,
    requestedOrg: string | null,
  ): Promise<ResolvedPrincipal> {
    const parts = API_KEY_SHAPE.exec(credential);
    const invalid = (): AppException =>
      new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_API_KEY_INVALID,
        message: 'API key is not valid',
      });
    if (!parts) throw invalid();

    const [, prefix, secret] = parts;

    return this.db.auth.transaction(async (raw) => {
      const tx = raw as Transaction;
      const key = await this.scopes.findApiKeyByPrefix(tx, prefix!);
      if (!key) {
        // Spend comparable work so a valid prefix with a wrong secret and an
        // unknown prefix are not distinguishable by timing.
        await this.credentials.verifyDummy(secret!);
        throw invalid();
      }
      if (!(await this.credentials.verify(key.keyHash, secret!))) throw invalid();

      if (requestedOrg && requestedOrg !== key.orgId) {
        throw new AppException({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.TENANCY_CONTEXT_MISMATCH,
          message: 'This credential cannot act in the requested organization',
        });
      }

      /**
       * The key's own authority, expressed as a grant so it flows through the
       * ordinary `PermissionEvaluator` path.
       *
       * Without this the principal carries an empty `roles` array, and the
       * evaluator's scope-coverage half — `roles.some(...)` — is vacuously false,
       * so the key authenticates and is then denied everything. Synthesizing the
       * grant is what lets an API key be authorized by exactly the same rule as a
       * user, with no special branch anywhere in the evaluator.
       *
       * The scope is the key's own binding and nothing wider: its workspace when
       * it has one, otherwise its organization. It is never `platform`, so a key
       * can never reach the control plane, and `scopeCovers` then refuses any
       * target above its binding — a workspace-bound key cannot perform an
       * organization-wide operation.
       *
       * It is computed here, before the creator intersection, because it is also
       * the scope that intersection is taken at.
       */
      const grantScope = key.workspaceId
        ? { scopeType: 'workspace' as const, scopeId: key.workspaceId }
        : { scopeType: 'organization' as const, scopeId: key.orgId };

      const requested = Array.isArray(key.scopes) ? (key.scopes as string[]) : [];
      const creatorAuthority = key.createdBy
        ? await this.creatorAuthorityAtBinding(tx, key.createdBy, grantScope, key.orgId)
        : [];
      /**
       * The intersection, recomputed on every request rather than snapshotted at
       * creation. A key whose creator has since lost a permission loses it too —
       * which is the whole point of not storing the creator's authority on the
       * key row (`RBAC.md` §5c). A key whose creator no longer exists resolves to
       * no permissions at all, not to its requested scopes.
       */
      const effective = requested.filter((s) => creatorAuthority.includes(s));

      // Bookkeeping and its audit row share this transaction, so the record of
      // an authentication cannot commit without the authentication's own state
      // change, or vice versa (ADR-003 D-2).
      await tx
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(schema.apiKeys.id, key.id));

      await this.audit.record(
        {
          // Platform scope: API-key authentication happens before any tenant
          // context is established, and `acc_auth` is confined to platform-scoped
          // rows. The organization the key belongs to is metadata, not the
          // record's scope.
          scopeType: 'platform',
          scopeId: null,
          actorType: 'api_key',
          actorUserId: null,
          actorApiKeyId: key.id,
          actorLabel: null,
          action: AUDIT_ACTIONS.API_KEY_AUTHENTICATED,
          resourceType: 'api_key',
          resourceId: key.id,
          outcome: 'success',
          before: null,
          after: null,
          // The key is identified by its row id only. Neither the presented
          // credential, its secret half, nor its prefix is recorded.
          metadata: { orgId: key.orgId, scopeType: grantScope.scopeType },
        },
        tx,
      );

      return {
        actorType: 'api_key' as ActorType,
        userId: null,
        apiKeyId: key.id,
        sessionId: null,
        tenant: {
          orgId: key.orgId,
          workspaceId: key.workspaceId,
          resellerId: null,
          isPlatformAdmin: false,
        },
        roles: [
          {
            // Synthetic, and namespaced so it can never collide with a real
            // `roles.id`. Nothing reads it as a foreign key.
            roleId: `api_key:${key.id}`,
            roleKey: 'api_key',
            scopeType: grantScope.scopeType,
            scopeId: grantScope.scopeId,
            orgId: key.orgId,
            // The key's effective set, carried on the grant itself, so an API-key
            // principal is structurally a single-grant user principal and the
            // evaluator needs no key-specific branch (ADR-005 D-1).
            permissions: effective,
          },
        ],
        permissions: effective,
        authMethod: 'api_key',
        authenticatedAt: new Date(),
        // A key is bound to exactly one organization and can never select another.
        authorizedOrganizationIds: [key.orgId],
      };
    });
  }

  /**
   * What the key's creator may legitimately confer **at the key's binding
   * scope** (`RBAC.md` §5c, ADR-005 D-4).
   *
   * The creator's flattened union is the wrong quantity, and was what this
   * previously used. A creator who is `read_only` in Organization A and
   * `org_admin` in Organization B holds `roles.create` *somewhere*; minting a
   * key bound to Organization A carrying it would move authority between
   * tenants through a credential. The same error one level down lets a creator
   * who administers a single workspace mint an organization-bound key with that
   * workspace's administrative permissions.
   *
   * So each creator grant is tested for coverage of the binding scope with the
   * same `scopeCovers` rule the evaluator uses, and only the grants that cover
   * it contribute their own permissions. It is the coherent-grant rule
   * (ADR-005 D-1) applied to the creator rather than to the caller, which is
   * why the two are corrected together and share a definition of "covers".
   *
   * The chain is read from the key's own columns rather than from anything on
   * the request — `api_keys.org_id`/`workspace_id` are the binding itself. The
   * reseller term is resolved because a reseller-scoped creator legitimately
   * covers the organizations beneath its reseller; omitting it would silently
   * strip a reseller admin's authority from every key it creates.
   */
  private async creatorAuthorityAtBinding(
    tx: Transaction,
    creatorId: string,
    bindingScope: { scopeType: 'organization' | 'workspace'; scopeId: string },
    orgId: string,
  ): Promise<string[]> {
    const creatorScopes = await this.scopes.forUser(tx, creatorId);

    const chain: ScopeChain = {
      resellerId: await this.scopes.resellerForOrganization(tx, orgId),
      orgId,
      workspaceId: bindingScope.scopeType === 'workspace' ? bindingScope.scopeId : null,
      teamId: null,
    };

    return [
      ...new Set(
        creatorScopes.grants
          .filter((grant) =>
            scopeCovers(
              { scopeType: grant.scopeType, scopeId: grant.scopeId },
              bindingScope,
              chain,
            ),
          )
          .flatMap((grant) => grant.permissions),
      ),
    ];
  }
}
