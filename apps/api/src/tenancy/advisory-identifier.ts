import { SetMetadata } from '@nestjs/common';
import { SCOPE_DEPTH, type AuthPrincipal, type TenantScopeType } from '@acc/contracts';

/**
 * Advisory tenant identifiers (`TENANCY.md` §2b).
 *
 * A tenant identifier that arrives on a request — in a query string, a path
 * segment, a body field or a header — is **advisory**. The authoritative
 * context was already resolved from the credential, before any handler ran:
 *
 *     authentication → ScopeResolver → organization selection → TenantContext
 *
 * This file is the cross-check against that resolved context, and only the
 * cross-check. It resolves nothing, reads no database, and can never widen what
 * a request reaches: it either agrees with the context already established, or
 * the request is refused with `403 TENANCY_CONTEXT_MISMATCH`. Keeping it a pure
 * assertion is what stops it drifting into a second tenant resolver — the
 * failure mode `TENANCY.md` §2b exists to prevent, where a supplied identifier
 * quietly becomes the identifier used.
 *
 * It is also not authorization. Whether the principal may perform an operation
 * *on* a scope is `PermissionEvaluator`'s question, asked once the target and
 * its ancestry are loaded. This answers only the narrower one: does the
 * identifier the caller supplied contradict the context the server derived?
 */

/** Where an advisory identifier is read from on the request. */
export type AdvisorySource = 'query' | 'param' | 'body' | 'header';

/** One advisory identifier a handler accepts. */
export interface AdvisoryIdentifierSpec {
  /** Which level of the tenancy tree the identifier names. */
  readonly level: TenantScopeType;
  readonly source: AdvisorySource;
  /** Parameter, field or header name. Headers are matched case-insensitively. */
  readonly key: string;
  /**
   * When true, the identifier's absence is `400 TENANCY_CONTEXT_REQUIRED`
   * rather than "no assertion to make". Defaults to false: most advisory
   * identifiers are optional narrowings.
   */
  readonly required?: boolean;
}

export const ADVISORY_TENANT_IDS = 'acc:tenancy:advisory-ids';

/**
 * Declares the advisory tenant identifiers a handler accepts, so
 * `AdvisoryTenantGuard` cross-checks every one of them.
 *
 * Declaring an identifier is the whole of the work — there is deliberately no
 * per-handler check to write, and therefore none to forget or to get subtly
 * wrong in the fifth copy. An identifier that is *not* declared is simply never
 * treated as a tenant identifier by this mechanism.
 */
export const AdvisoryTenantIds = (...ids: AdvisoryIdentifierSpec[]) =>
  SetMetadata(ADVISORY_TENANT_IDS, ids);

/**
 * The shape a raw request value resolved to.
 *
 * `ambiguous` is the deliberate treatment of a repeated or structured
 * parameter. Express parses `?orgId=A&orgId=B` into an array and `?orgId[x]=A`
 * into an object; picking an element from either would make the security
 * decision depend on parameter order, so both are refused outright. Refusing is
 * the only behaviour that is both deterministic and fail-closed.
 */
export type AdvisoryValue =
  | { readonly state: 'absent' }
  | { readonly state: 'ambiguous' }
  | { readonly state: 'malformed' }
  | { readonly state: 'ok'; readonly value: string };

/**
 * Matches the identifier shape `ParseUUIDPipe` already accepts on path
 * parameters, so the same identifier is judged the same way wherever it
 * arrives. Deliberately version-agnostic: platform identifiers are UUIDv7.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeAdvisoryValue(raw: unknown): AdvisoryValue {
  if (raw === undefined || raw === null) return { state: 'absent' };
  // Arrays and qs's object form both mean the caller sent more than one value,
  // or a structured one. Neither has a defensible "the" value.
  if (typeof raw !== 'string') return { state: 'ambiguous' };

  const value = raw.trim();
  // An empty parameter is a supplied identifier that names nothing, not an
  // omitted one. Treating it as absent would let `?orgId=` skip the assertion.
  if (!UUID.test(value)) return { state: 'malformed' };
  return { state: 'ok', value };
}

/**
 * The identifiers a principal's *already-resolved* context admits at `level`.
 *
 * `null` means the resolved context does not pin this level at all — the
 * principal holds a grant above it, so every identifier beneath that grant is
 * in scope and nothing here can distinguish one from another without reading
 * the database. That case is not waved through: it is handed on to the layers
 * that can answer it with the resource in hand — `PermissionEvaluator` for
 * target-scope coverage, RLS for organization isolation, and a `404` for a row
 * that was never visible (`API.md` §3a). Answering it here instead would mean
 * loading tenancy rows to validate a hint, which is exactly the resolver this
 * mechanism must not become.
 *
 * An empty array means the opposite: the level *is* pinned and nothing is
 * admissible, so every supplied identifier is a mismatch. Fail closed.
 */
export function admissibleAdvisoryIds(
  principal: AuthPrincipal,
  level: TenantScopeType,
): readonly string[] | null {
  const orgId = principal.tenant.orgId;
  if (!orgId) return [];

  // The organization is always pinned once a context exists: it is the single
  // organization this request acts in (ADR-003 D-4).
  if (level === 'organization') return [orgId];

  // Grants that bear on the resolved organization. `platform` and `reseller`
  // grants carry no `orgId` of their own; the organization they are being used
  // at was already validated by `ScopeResolver.selectOrganization`.
  const relevant = principal.roles.filter(
    (grant) =>
      grant.scopeType === 'platform' || grant.scopeType === 'reseller' || grant.orgId === orgId,
  );

  // A grant above this level covers every scope at it.
  if (relevant.some((grant) => SCOPE_DEPTH[grant.scopeType] < SCOPE_DEPTH[level])) return null;

  const admissible = relevant
    .filter((grant) => grant.scopeType === level && grant.scopeId)
    .map((grant) => grant.scopeId!);

  // The workspace the server itself derived counts too — a team-scoped
  // principal has no workspace grant, but its workspace is resolved from the
  // team it does hold (`TENANCY.md` §2a).
  if (level === 'workspace' && principal.tenant.workspaceId) {
    admissible.push(principal.tenant.workspaceId);
  }

  return [...new Set(admissible)];
}
