# Alendei Communications Cloud — Product Requirements Document

Status: Phase 0 draft. No application code exists. This document defines *what* the platform is and *why*; see `ARCHITECTURE.md` for *how*.

## 1. Vision

Alendei Communications Cloud (ACC) is a multi-tenant, provider-agnostic communications platform operated by Alendei Platforms Pvt. Ltd. It lets Alendei, its resellers, and their end-customer organizations send and receive messages across WhatsApp, RCS, SMS, Email, and Voice through a single API, campaign engine, and journey/workflow engine — without any business logic ever depending on a specific external provider.

The platform must survive the loss, degradation, or replacement of any single communications provider without customer-visible disruption, and must let Alendei re-route traffic across providers and channels in real time, based on actual delivery outcomes, without a code deployment.

**Product positioning (strategic, not a Phase 0 implementation commitment):** ACC is an API-first, multi-tenant communications and customer-engagement platform with a provider-independent communications control plane. Its application layer — campaigns, journeys, unified inbox, contacts/CDP, chatbots, CRM, and AI agents — is intended to eventually reach functional parity with engagement platforms such as AiSensy, WATI, and WhatChimp. ACC is deliberately **not** positioned merely as "WhatsApp marketing software." What differentiates ACC architecturally from those tools is the communications control plane beneath the application layer — multi-provider routing, hot-swap, cross-channel and cross-provider failover, and an immutable financial ledger — none of which a single-channel engagement tool provides. The layered product architecture that supports this (Communication Core → Engagement Layer → Experience Applications) is defined in `ARCHITECTURE.md` §21; this document's near-term scope (Phase 0–7) remains the communications control plane and billing, with the broader engagement/application layer sequenced in `ROADMAP.md` Phase 8 onward.

## 2. Problem statement

Alendei Platforms today (implicitly, via prior white-label/third-party tooling) is exposed to single-provider lock-in: business logic, billing, and reporting are coupled to specific vendor APIs. This creates:

- Outage risk when a single WhatsApp/SMS/RCS vendor degrades.
- Inability to route by cost, quality, or geography.
- No canonical, immutable financial record of what was actually sent, delivered, and billed.
- Difficulty white-labelling the platform for resellers.

ACC replaces this with a provider-abstracted core where providers are swappable infrastructure, not architecture.

## 3. Goals (Phase 0–12 horizon)

1. Provider- and channel-agnostic message sending with policy-driven routing and delivery-outcome-based fallback (WhatsApp → RCS → SMS and all permutations, including multi-provider-per-channel chains).
2. Strict multi-tenant hierarchy — `Alendei → Reseller → Organization → Workspace → Team → User` — with isolation enforced at every layer (API, DB, cache, queue, storage, search, logs).
3. RBAC + ABAC authorization derived only from authenticated session/token context, never client-supplied tenant IDs.
4. An immutable usage ledger as the sole source of financial truth, supporting prepaid/postpaid, wallets, credit limits, GST-aware invoicing, refunds, adjustments, reseller markup.
5. Campaign, journey/workflow, and unified inbox/conversation capabilities built on top of the same message core used by transactional APIs.
6. An AI Gateway that abstracts AI providers/models the same way the Communication Gateway abstracts messaging providers.
7. Admin-operable provider/routing control plane: add, enable/disable, drain, test, re-prioritize, re-weight, canary-migrate, and roll back providers — all without redeploying the application.
8. Observability sufficient to trace any message from API call to final delivery/failure across every hop, with correlation across tenant, customer, campaign, journey, provider.
9. A migration path off existing third-party/white-label platforms without a "big bang" cutover.
10. A layered product architecture — Communication Core → Engagement Layer → Experience Applications (`ARCHITECTURE.md` §21) — so that future capability classes (contacts/CDP, templates, campaigns, journeys/automation, unified inbox/conversations, chatbot/flow builder, CRM/sales, commerce, AI agents, reseller/white-label) are additive callers of the Communication API and never parallel integrations that bypass routing, eligibility, fallback, billing, or security (`ARCHITECTURE.md` §26).

## 4. Non-goals (Phase 0)

- No connection to any real external provider (WhatsApp Business Platform, SMS aggregator, RCS hub, email/voice vendor, or AI model provider).
- No provider credentials requested, stored, or required.
- No production infrastructure stood up.
- No commitment to a single vendor for any channel — architecture must support N providers per channel from day one.
- No claim of compliance certification (SOC 2, ISO 27001) — only alignment with control objectives; certification is a separate, later business process.

## 5. Primary personas

| Persona | Description | Primary needs |
|---|---|---|
| Alendei platform admin | Operates the control plane across all tenants | Provider health, routing policy control, global billing/reporting, audit |
| Reseller admin | Manages a book of organizations under white-label branding | Reseller-scoped reporting, markup/margin control, branded UI |
| Organization admin | A business customer's administrator | Users, teams, workspaces, billing, campaign/journey authoring, API keys |
| Workspace/team user | Day-to-day operator (support, marketing) | Inbox, campaigns, contacts, templates, reports scoped to their workspace/team |
| Developer (org's engineering team) | Integrates via API | REST API, webhooks, idempotency, sandbox/simulator |
| End customer / contact | Recipient of messages | Not a platform user; subject of consent, suppression, and delivery |

## 6. Tenant hierarchy (summary)

```
Alendei (platform)
  └─ Reseller (optional; "Alendei Direct" is the implicit default reseller)
       └─ Organization ("Customer" — the paying tenant)
            └─ Workspace (brand/business-unit scope; unit of white-label branding and of usage
                           roll-up for reporting — not itself a billing entity; wallets, credit
                           accounts and invoices exist only at organization level)
                 └─ Team (permission-scoping group within a workspace)
                      └─ User
```

The authorization scope hierarchy mirrors this structure exactly — `platform → reseller → organization → workspace → team` — and is defined normatively in `TENANCY.md` §1a. Full isolation model, RBAC/ABAC, and rationale: see `TENANCY.md` and `RBAC.md`.

## 7. Functional scope by domain

- **Messaging core**: unified message model, multi-channel send, delivery tracking, unified inbox/conversation threading.
- **Routing & resilience**: channel routing, eligibility filtering, provider routing policies, delivery-based fallback (subject to `requested_channel_id` hard-constraint semantics — `ROUTING_ENGINE.md` §1a), cross-provider/cross-channel/combined failover, circuit breaking.
- **Campaigns**: bulk sends against contact segments, template-driven, schedule/throttle-aware, audience targeting/personalization, delivery/conversion analytics (`ARCHITECTURE.md` §21).
- **Journeys / automation**: multi-step, multi-channel, event- and schedule-triggered workflows with branching, delay, and action steps, including webhook/API/CRM/human/AI handoff actions (`ARCHITECTURE.md` §21).
- **Contacts / CDP**: contact identities across channels, custom fields/tags/segments, consent capture, suppression lists (DND/opt-out), DLT-aware routing for India SMS, customer timeline (`ARCHITECTURE.md` §21).
- **Unified inbox / conversations**: multi-channel conversation threading, team/agent assignment and routing, internal notes, SLA — channel/provider-agnostic where channel semantics permit (`ARCHITECTURE.md` §21).
- **Chatbot / flow builder**: visual bot flows operating strictly through the Communication Orchestrator, never bypassing eligibility/routing/fallback (`ARCHITECTURE.md` §23, §26).
- **CRM / sales**: leads, pipeline, stages, tasks, assignment, conversation-to-lead conversion — a future product application on top of the engagement layer, not a parallel provider integration (`ARCHITECTURE.md` §21).
- **Commerce**: catalog messaging, order notifications, abandoned-cart and commerce workflows — future capability, same architectural boundary as above.
- **Billing**: immutable usage ledger, transaction-specific pricing via a Pricing & Rating Engine, wallets/credit accounts, invoices, GST, refunds/adjustments, auto-recharge, reseller markup, revenue reporting (`BILLING.md` §§10–17).
- **Reseller & white-label**: reseller-scoped branding, domains, own pricing/templates/campaigns/inbox/API credentials, and reporting (`ARCHITECTURE.md` §16, `TENANCY.md` §4).
- **AI Gateway / AI agents**: provider-agnostic access to AI models for use cases such as reply suggestion, summarization, intent detection, lead qualification, and AI-driven sales/support agents — never a hard dependency on one AI vendor.
- **Admin control center**: provider/routing/fallback configuration, health dashboards, canary and rollback tooling.
- **Security & compliance alignment**: MFA, SSO-ready auth, encryption, audit trail, DPDP/TRAI-DLT/Meta policy/GDPR/OWASP alignment (not certification).

## 8. Key non-functional requirements

| Area | Requirement |
|---|---|
| Availability | No single provider outage may cause customer-visible message loss; fallback must be automatic |
| Consistency | Financial records must be append-only and reconstructable; no financial fact may be mutated in place |
| Portability | Must deploy to AWS, Azure, GCP, private cloud, or on-prem Linux without architectural change |
| Extensibility | Adding a new provider or channel must not require changes to campaign/journey/business logic |
| Operability | Routing/fallback/provider changes must take effect without application redeploy or restart |
| Traceability | Every message must be traceable end-to-end via correlation_id/trace_id across logs, metrics, traces, and the audit log |
| Idempotency | A correctly idempotent API retry never creates a second logical message; internal processing never creates a duplicate provider/channel attempt; the financially authoritative billing outcome for a billable transaction or logical communication lifecycle (`BILLING.md` §10 — a logical message today; the same guarantee, not a weaker one, applies as non-messaging transaction types such as Voice/Voice AI/AI/API usage are added) is never duplicated; redelivered/duplicate webhooks and events are processed idempotently (acknowledged, never reprocessed into a second business action); out-of-order events never regress or corrupt message state. This is a guarantee about mechanisms ACC itself controls — see §8a for the explicitly acknowledged residual risk of duplicate *physical* delivery by an external provider, which this NFR does not and cannot cover |

### 8a. What ACC guarantees, and what it explicitly does not

Precise language matters here, because "exactly-once" is easy to promise and impossible to fully deliver against systems ACC does not control. This document commits to the following, and no more:

**ACC guarantees** (built entirely from mechanisms ACC itself controls — `DATABASE.md` §7, `ARCHITECTURE.md` §9):
- Logical-message idempotency: a retried API request never creates a second logical message.
- Internal attempt idempotency: a retried worker, duplicate event, or double-firing scheduler never creates a duplicate provider/channel attempt.
- Idempotent event consumption: every internal consumer safely handles redelivery of the same event.
- Duplicate inbound webhook protection: a re-delivered provider webhook is acknowledged but never reprocessed into a second business action.
- Duplicate outbound webhook delivery handling: a redelivered or replayed outbound webhook never represents itself as a new event to the receiving customer system.
- Billing correctness: a single financially-authoritative billing lifecycle/outcome per **billable transaction or logical communication lifecycle** (`BILLING.md` §10) — a logical message for ordinary channel sends, and the corresponding lifecycle unit for non-messaging/hybrid transaction types (Voice, Voice AI, AI processing, API usage, platform services) — derived solely from the immutable ledger. The *number, timing, and amount* of customer-charge ledger entries within that outcome are governed by the organization's billing policy (`BILLING.md` §5) and pricing policy (`BILLING.md` §17) — "one authoritative outcome" is not the same claim as "exactly one charge," and this document does not conflate the two (`FALLBACK_ENGINE.md` §6).
- Deterministic fallback state: at any instant, exactly one attempt is authoritative for a given message, enforced by a database transaction, not by convention.

**ACC does not guarantee** — and no marketing, sales, or product material should imply otherwise:
- Exactly-once **external** delivery. Where a provider offers no idempotency key and a network ambiguity occurs (ACC sent a request, the response was lost, and ACC cannot determine whether the provider processed it), a retry carries a genuine, non-zero risk of a duplicate submission on the provider's own system. ACC minimizes this (provider idempotency keys where available, status-lookup before retry, bounded retry counts) but cannot eliminate it for providers that don't support the necessary mechanism.
- Prevention of a recipient receiving more than one physical message across a fallback chain in the rare case where a deprioritized channel's delivery lands after a fallback message was already sent — no provider offers a reliable recall API. This is a disclosed, accepted risk (`DECISIONS.md`), not a defect being silently tolerated.

## 9. Success criteria for Phase 0

Phase 0 is complete when: the documents listed in the Phase 0 request exist under `/docs`, are internally consistent (shared vocabulary, ID conventions, and entity model), identify open decisions and risks explicitly, and a named reviewer (product owner) has approved proceeding to Phase 1. Phase 0 produces **no application code, no infrastructure, and no provider integration**.

## 10. Related documents

`ARCHITECTURE.md`, `TENANCY.md`, `DATABASE.md`, `API.md`, `EVENTS.md`, `PROVIDER_ADAPTER.md`, `ROUTING_ENGINE.md`, `FALLBACK_ENGINE.md`, `SECURITY.md`, `RBAC.md`, `BILLING.md`, `OBSERVABILITY.md`, `TESTING.md`, `DEPLOYMENT.md`, `DR.md`, `RUNBOOK.md`, `ROADMAP.md`, `DECISIONS.md`.
