# Phase 3 — API contract requirements register

Companion to `ADR-014-PHASE-3-WHATSAPP-ORCHESTRATION.md` (06-Oct-2026). **No Phase 3 endpoint exists and the OpenAPI document is unchanged.** This register lists what each Phase 3 resource's contract must settle before implementation, and marks only what is already established.

- **EXISTING** — an established repository convention that applies to every new endpoint (cited).
- **UNRESOLVED — DO NOT IMPLEMENT** — must be frozen first (open decision id in brackets).

## 1. Conventions every Phase 3 endpoint inherits (EXISTING)

| Aspect | Contract | Source |
|---|---|---|
| Authentication | Bearer session; API keys are organization- or workspace-bound | `API.md` §3; ADR-007 |
| Organization context | `X-Acc-Organization`, validated server-side; mismatch → `403 TENANCY_CONTEXT_MISMATCH` | `API.md`; `FRONTEND_API_CONTRACT.md` |
| Authorization | `@RequiresPermission` on every route, asserted at the resource's scope inside the request transaction, with pre-commit coverage containment; no role-name logic | `RBAC.md` §2a; ADR-005; ADR-012 |
| Isolation | Tenant RLS by organization; workspace and team enforced by the application layer; authorize before disclose | `TENANCY.md` §1a.4 |
| Envelope | `{data}`; lists `{data, page:{nextCursor, hasMore, limit}}`; keyset pagination with signed opaque cursors | `API.md`; `FRONTEND_API_CONTRACT.md` |
| Errors | `{error:{code, message, correlationId, retryable, details?}}`; validation `400 VALIDATION_FAILED` with `details.issues` | `API.md`; `FRONTEND_API_CONTRACT.md` §10 |
| Idempotency | `Idempotency-Key` on creating `POST`s, `(org_id, endpoint, key)`, request hash, replay and conflict codes — **reused by Phase 3 (ADR-014 F15)** | `API.md` §4a; ADR-006 |
| Audit | Every mutation audited in its own transaction, with before/after; refusals audited | `SECURITY.md` §4 |
| Rate limits | General limiter on every route | `API.md` §5 |

## 2. Resources

For every resource below, the following are **UNRESOLVED — DO NOT IMPLEMENT** unless the row says otherwise:

- the endpoint list
- the permission key [P3-D09]
- the scope and workspace context [P3-D07, P3-D08]
- the request and response shapes
- resource-specific errors
- whether idempotency applies beyond the general convention
- which actions are audited [P3-D26]

| Resource | Endpoints named anywhere | Additional open points |
|---|---|---|
| Contacts | `/contacts` (`ROADMAP.md` §6) | Ownership is workspace per the planned table (`DATABASE.md` §3) [P3-D07]; deletion semantics (`deleted_at`) |
| Contact identities | none | Normalization and uniqueness [P3-D25]; nested or top-level path |
| Consent | none | Semantics and defaults [P3-D23] |
| Suppressions | none | Organization-only ownership per the planned table; address-only suppressions [P3-D23]; who may lift [P3-D09] |
| Templates | `/templates` (`ROADMAP.md` §6) | Ownership, approval under the simulator, use in sends [P3-D21] |
| Messages | `/messages` (`ROADMAP.md` §6) | Synchronous or asynchronous, idempotency requirement, API-key use, rate limit [P3-D24]; refusal behaviour [P3-D22]; state model [P3-D10]; simulator selection [P3-D19] |
| Message attempts | none (read-only by nature) | Shape and states [P3-D11]; nested under message or not |
| Message events | none (read-only by nature) | Types, ordering and pagination order [P3-D12] |
| Organization provider assignments | none | Every point [P3-D01–P3-D06] |

## 3. What is explicitly not a Phase 3 endpoint (ADR-014)

Routing-policy or fallback-policy CRUD, routing weights, canary (F18); campaigns, journeys (F13); billing (F14); credential management (F3); WebSocket subscriptions (F12); event-stream endpoints (F11). `POST /providers/:id/test-send` stays the Phase 2 direct, non-persisted test path and is not a messaging endpoint (ADR-014 §7).
