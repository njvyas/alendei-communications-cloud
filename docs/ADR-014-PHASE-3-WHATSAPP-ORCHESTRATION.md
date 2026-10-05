# ADR-014 — Phase 3: WhatsApp-first message orchestration (documentation freeze)

**Status:** Phase 3.0 documentation freeze, 06-Oct-2026. **Partially frozen.** No Phase 3 code, migration, API or OpenAPI change exists or is authorized by this document. Phase 3.1 implementation must not start until the decisions in `PHASE-3-OPEN-DECISIONS.md` marked `REQUIRES USER APPROVAL` are approved.

**Source of authority — read this first.** The approved architecture is referred to as ADR-014/v9. **The full v9 text was not available when this document was written.** What is recorded as FROZEN below is exactly the set of v9 decisions the user stated explicitly in the Phase 3 instructions of 05/06-Oct-2026. Nothing else is attributed to v9. Every point those statements do not settle is marked **UNRESOLVED — requires architecture approval** and registered in `PHASE-3-OPEN-DECISIONS.md`; when the full v9 text is supplied, this document is to be re-checked against it.

Markers used throughout:

- **FROZEN (v9)** — stated explicitly as an approved ADR-014/v9 decision.
- **EXISTING CONTRACT** — already established and implemented in the repository (Phases 1–2), with the file that establishes it.
- **EXISTING TARGET DESIGN** — written in the canonical architecture documents but never implemented; whether it applies to Phase 3 as written is **not** established and is listed as an open decision.
- **UNRESOLVED** — requires an architecture decision (decision id in brackets).

## 1. Decisions frozen from ADR-014/v9

| # | Decision | Status |
|---|---|---|
| F1 | **WhatsApp-first.** Phase 3 builds the message path for the WhatsApp channel first. | FROZEN (v9) |
| F2 | **SimulatorAdapter only.** No real provider adapter. | FROZEN (v9) |
| F3 | **No real credentials and no vendor network calls.** Credential architecture stays governed by the documentation-only contract of Phase 2.5 (`PROVIDER_ADAPTER.md` §4a). | FROZEN (v9); contract EXISTING |
| F4 | **Provider-to-provider fallback is in Phase 3** — between providers of the same channel. | FROZEN (v9) |
| F5 | **No cross-channel fallback** in Phase 3. | FROZEN (v9) |
| F6 | **Fallback principle:** provider-to-provider only; deterministic; subject to provider-assignment eligibility, provider lifecycle, health and circuit state, and authoritative CircuitAdmission; no unsafe duplicate submission. | FROZEN (v9) — the rules that implement it are UNRESOLVED (§6) |
| F7 | **PostgreSQL is the correctness boundary.** | FROZEN (v9); consistent with `ARCHITECTURE.md` §9c, `FALLBACK_ENGINE.md` §4 |
| F8 | **Redis is advisory only** — never required for correctness. | FROZEN (v9); consistent with `ARCHITECTURE.md` §9c |
| F9 | **PostgreSQL polling and recovery** — work is found and recovered by polling PostgreSQL. | FROZEN (v9); mechanism UNRESOLVED [P3-D18] |
| F10 | **Durable simulator invocation fencing.** | FROZEN (v9) as a principle; representation UNRESOLVED [P3-D17] |
| F11 | **No Kafka and no transactional outbox** in Phase 3. | FROZEN (v9) |
| F12 | **No WebSocket execution** in Phase 3. | FROZEN (v9) |
| F13 | **No campaigns, no journeys.** | FROZEN (v9) |
| F14 | **No billing** (no rating, pricing, ledger or charges). | FROZEN (v9) |
| F15 | **Phase 1C idempotency is reused** (no new idempotency mechanism). | FROZEN (v9); mechanism EXISTING (§3) |
| F16 | **Phase 2 CircuitAdmission is authoritative** before every provider submission. | FROZEN (v9); EXISTING (`PROVIDER_ADAPTER.md` §6h) |
| F17 | **Canonical hierarchy: PLATFORM → RESELLER → ORGANIZATION → WORKSPACE → TEAM.** | FROZEN (v9); EXISTING (`TENANCY.md` §1a) |
| F18 | **Advanced routing stays out of Phase 3:** dynamic routing weights, routing-policy CRUD, optimization, canary routing, advanced routing strategy. | FROZEN (v9) |
| F19 | A provider-assignment entity named **`organization_provider_assignments`** is part of Phase 3. | FROZEN (v9) as a named entity only; every rule UNRESOLVED (§4) |

## 2. Existing contracts Phase 3 inherits unchanged

| Contract | Where established |
|---|---|
| `ProviderAdapter` port; `SimulatorAdapter` (the only adapter); submission-time behaviours `SUCCESS`, `TIMEOUT`, `500`, `429`, `INVALID_CREDENTIALS`, `INVALID_REQUEST`, `SLOW_RESPONSE`; the 3000 ms platform submission timeout | `PROVIDER_ADAPTER.md` §2, §7; `ROADMAP.md` §5b 2.2 |
| Normalized failure taxonomy and its classification (§6 below) | `PROVIDER_ADAPTER.md` §5b; `packages/contracts/src/provider-health.ts` |
| CircuitAdmission: process-local, single-use, provider-bound, short-lived token; `ProviderSubmissionExecutor.execute` redeems one before any adapter `send()`; routing eligibility is advisory | `PROVIDER_ADAPTER.md` §6h; ADR-013 "Gate D.3 final remediation" |
| Provider lifecycle (`active`, `disabled`, `draining`), health and circuit state machines, the platform-wide circuit policy | `PROVIDER_ADAPTER.md` §5–§6 |
| Hot reload: advisory configuration snapshot, never an authorization or admission source | `PROVIDER_ADAPTER.md` §3a |
| Credential reference contract CR-1–CR-8 (documentation only) | `PROVIDER_ADAPTER.md` §4a |
| Tenancy: five-scope hierarchy, downward-only inheritance, RLS isolates to the organization and the application layer enforces workspace and team | `TENANCY.md` §1a, §1a.4; `RBAC.md` |
| Organization selection by `X-Acc-Organization`, validated server-side (`TENANCY_CONTEXT_MISMATCH` on a mismatch) | `API.md`; `FRONTEND_API_CONTRACT.md`; `scope-resolver.service.ts` |
| Workspace context derived only from a grant that names a workspace — no client workspace selector exists | `scope-resolver.service.ts` (Phase 1C) |
| Permission keys are `{domain}.{action}`; authorization never depends on a role name | `packages/contracts/src/permissions.ts`; `RBAC.md` |
| API idempotency: `Idempotency-Key`, stored per `(org_id, endpoint, key)`, request hash, replay, in-progress and mismatch codes | `API.md` §4a; ADR-006; `DATABASE.md` §7.1 |
| Response envelope `{data}` / `{data, page}`, keyset pagination, error envelope `{error:{code, message, correlationId, retryable, details?}}` | `API.md`; `FRONTEND_API_CONTRACT.md` |
| Every mutation audited in its own transaction; refusals audited as `authorization.denied` | `SECURITY.md` §4; ADR-005 |

## 3. Idempotency (F15)

FROZEN (v9): Phase 1C idempotency is reused. EXISTING: the API-level mechanism of `API.md` §4a / `DATABASE.md` §7.1 (organization-namespaced). EXISTING TARGET DESIGN: `DATABASE.md` §7 also describes attempt identity and provider idempotency keys (`message_attempts.provider_idempotency_key`, derived from the attempt id), and `idempotency_keys.status = failed` semantics "designed for the Phase 3 messaging send path". Which of these Phase 3 adopts as written: UNRESOLVED [P3-D11, P3-D24].

## 4. Organization provider assignments (F19)

| Item | Status |
|---|---|
| Name `organization_provider_assignments` | FROZEN (v9) |
| Ownership by an organization | UNRESOLVED [P3-D01] — implied by the name, not stated |
| Relationship to the platform provider catalogue (`providers`) | UNRESOLVED [P3-D01] |
| What makes a provider eligible for an organization | UNRESOLVED [P3-D02] |
| Priority and ordering semantics | UNRESOLVED [P3-D03] |
| Inheritance to workspaces; team behaviour | UNRESOLVED [P3-D04] |
| Who may create, update, delete; permissions; scope | UNRESOLVED [P3-D05] |
| RLS model; parent/child integrity; cross-reseller and cross-organization isolation | UNRESOLVED [P3-D06]. EXISTING constraints any answer must satisfy: tenant RLS isolates by organization (`TENANCY.md` §1a.4); the catalogue is readable only under a validated platform-scope claim (ADR-013 F-3), which a tenant request does not hold (ADR-013 2.4 residual (e)(4)) |

## 5. Workspace context

EXISTING: the organization is selected by `X-Acc-Organization` and validated against the caller's grants; a workspace context exists only when the caller's grant names a workspace. Nothing else exists. How an organization-scoped user identifies the workspace of a workspace-owned resource, how workspace- and team-scoped users are resolved, and what a mismatched or cross-organization workspace identifier returns are **UNRESOLVED** [P3-D07, P3-D08]. Whatever is decided must keep the server authoritative: a client never establishes ownership by claiming an identifier.

## 6. Provider fallback

FROZEN (v9): F4, F5, F6, F16, F18.

EXISTING (`PROVIDER_ADAPTER.md` §5b) — the Phase 2 classification the fallback principle refers to:

| Normalized outcome | Phase 2 classification |
|---|---|
| `timeout`, `provider_error`, `rate_limited`, `unknown` | **provider failure** (counts toward the circuit) |
| `invalid_request`, `invalid_recipient`, `unsupported_content`, `auth_error`, `configuration_error` | **neutral** — the request's, the customer's or our configuration's fault; never counted as provider outage |
| accepted | success |

UNRESOLVED: which outcomes **trigger** fallback (the Phase 2 classification governs the circuit, not fallback) [P3-D13]; whether a `timeout` or `unknown` outcome may be followed by another provider without an unsafe duplicate [P3-D16]; termination conditions [P3-D14]; same-provider retry [P3-D15]; the ordering source [P3-D03].

**Conflict reported, not resolved:** `FALLBACK_ENGINE.md` §1–§2 defines fallback as triggered by **delivery outcome** within a wait window, configured by `fallback_policies`/`fallback_steps` and re-resolved through routing policies (`ROUTING_ENGINE.md` §4). Phase 3 excludes routing-policy CRUD (F18), and no delivery behaviour is frozen for the simulator [P3-D20]. Which parts of that target design Phase 3 builds is [P3-D13, P3-D30].

## 7. SimulatorAdapter

EXISTING: `POST /providers/:id/test-send` (Phase 2.2) is a direct, platform-scope, synthetic submission to one provider: it persists **no** message, requires `providers.test_send`, takes the simulator behaviour in the request body, and records only `provider.test_sent` (plus health samples). It is not the Phase 3 send path.

FROZEN (v9): a Phase 3 message is sent through the SimulatorAdapter only, and the send path is persisted (PostgreSQL correctness boundary). The future `POST /messages` (named in `ROADMAP.md` §6) must exercise the complete persisted lifecycle. **How a simulator behaviour is selected for a persisted message is UNRESOLVED** [P3-D19]; delivery/webhook behaviours are UNRESOLVED [P3-D20].

## 8. Message lifecycle

Nothing about the state machines is stated in the v9 decisions available. EXISTING TARGET DESIGN, not frozen: the message lifecycle of `ARCHITECTURE.md` §6–§6a, the attempt status set of `DATABASE.md` §6, the event catalogue of `EVENTS.md` §4. Their applicability to Phase 3 — which states exist without delivery webhooks, how circuit refusal and fencing appear, which event types are recorded — is UNRESOLVED [P3-D10, P3-D11, P3-D12].

## 9. Templates, consent, suppression

Not stated in the v9 decisions available. EXISTING TARGET DESIGN: the planned `templates`, `consents`, `suppressions` tables (`DATABASE.md` §3). Ownership, approval behaviour under the simulator, precedence among suppression, consent, template validity and provider eligibility, and what a refusal persists are UNRESOLVED [P3-D21, P3-D22, P3-D23].

## 10. Permissions

No Phase 3 permission key exists, and none is stated by the v9 decisions available. The candidate names `contacts.read`, `contacts.manage`, `templates.read`, `templates.manage`, `suppressions.read`, `suppressions.manage`, `messages.read`, `messages.send` follow the existing `{domain}.{action}` convention but are **not frozen**: UNRESOLVED — permission contract decision required [P3-D09].

## 11. API contracts

No Phase 3 endpoint is frozen and the OpenAPI document is unchanged. The requirements each endpoint must settle are registered in `PHASE-3-API-CONTRACT-REGISTER.md`; general conventions (envelope, pagination, error body, idempotency header, audit-in-transaction) are EXISTING CONTRACT.

## 12. Required security and concurrency tests

Required categories (evidence to be produced by Phase 3 implementation; none claimed here): horizontal isolation; vertical escalation; scope substitution (forged organization, workspace or team identifiers); enumeration (authorize before disclose, `TENANCY.md`); cross-reseller, cross-organization, workspace and team isolation; provider-assignment, message, contact, suppression and template isolation; RLS bypass with the service layer bypassed; CircuitAdmission forgery, reuse, foreign and expired tokens (existing Gate D.3 pattern); stale execution (a fenced-out or superseded invocation must not record — F10); duplicate submission; idempotency replay, in-progress and payload mismatch; crash recovery through PostgreSQL polling (F9). Existing test patterns to extend: `provider-router-contract.sec-spec.ts`, `idempotency.sec-spec.ts`, `database-integrity.sec-spec.ts`, the route-authorization coverage and scope-creep architecture specs.

## 13. Documentation reconciled by this ADR

Only contradictions that the frozen decisions resolve were changed: `ROADMAP.md` §6 (fallback is in Phase 3; no Kafka/outbox; "single attempt" removed) and §8 (basic provider-to-provider fallback is no longer Phase 5's); pointer notes in `FALLBACK_ENGINE.md`, `ROUTING_ENGINE.md`, `EVENTS.md`, `DECISIONS.md`. Every other conflict is reported in `PHASE-3-OPEN-DECISIONS.md` §B without choosing a side.
