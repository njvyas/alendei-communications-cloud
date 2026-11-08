# ACC — Phase 8B Campaigns: Backend Implementation Handover

**Document Version:** 1.0.0  
**Date:** 08-Nov-2026  
**Status:** PROPOSED — PENDING ARCHITECTURAL REVIEW & OWNER APPROVAL  
**Authoritative References:**  
- `docs/ROADMAP.md` §11b (Phase 8B Campaigns)
- `docs/ARCHITECTURE.md` §11 (Campaign Architecture), §12 (Journeys separation), §15 (Billing), §17 (Tenancy)
- `docs/DATABASE.md` §6 (Messages), §8 (Templates & Campaigns), §10 (Billing PR 7-1), §14a (Model B RLS)
- `docs/DECISIONS.md` §1zi (Phase 7 Billing Decisions, OD-7-1 to OD-7-14), §1w (Phase 4.1), §1zg (Phase 4.2)
- Merged PR #80 (Phase 8A Contacts Frontend), PR #82 (Contact Activity Backend), PR #86 (Phase 8B Frontend), PR #89 (Phase 8A-S Audience Resolution Backend), PR #88 (Phase 7.1 Ledger Foundation)

---

## Executive Summary & Architectural Posture

This handover document provides the engineering specification and execution plan for the **Phase 8B Campaigns Backend** within the Alendei Communications Cloud (ACC) platform.

### Core Architecture Invariants
1. **Campaigns are callers of the shared communication core, not a parallel send engine.**  
   Campaign execution enqueues standard messages through the core dispatch and routing pipeline (`MessagesService` / PR 7-3 shared send core). Campaigns possess zero private provider paths, zero direct adapter calls, and zero custom retry loops (`ARCHITECTURE.md` §11).
2. **Audience resolution logic is never duplicated.**  
   All audience queries, tag filtering, suppression exclusion, and consent filtering reuse the merged Phase 8A-S engine (`ContactsService.resolveAudience`) without redundant reimplementation.
3. **Billing and wallet enforcement cannot be bypassed.**  
   Campaign dispatch strictly depends on Phase 7 billing foundation (PR 7-1, PR 7-2, PR 7-3) and **Gate 7-A approval**. Phase 7.2 (Pricing & Rating) alone does **not** authorize message sending; funds reservation and ledger posting (PR 7-3) are mandatory prerequisites.
4. **Campaign dispatch remains disabled until all dependencies clear.**  
   The initial backend PRs deliver persistence, CRUD APIs, audience preview, and recipient materialization. The dispatch trigger remains disabled with explicit API and UI notices until Phase 7.3 and Gate 7-A are accepted.
5. **Phase 8C Journeys remains strictly separate.**  
   No event triggers, multi-step branching, wait conditions, or automation graphs are introduced in Phase 8B.

---

## 1. Implementation Sequence & PR Boundaries

To eliminate risk and decouple development from the in-progress Phase 7 pricing work, Phase 8B is partitioned into three incremental, reviewable PRs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 8A-S Contact Audience Resolution (PR #89) — MERGED                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Phase 8B Campaigns Frontend Slice (PR #86) — MERGED                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Phase 7.1 Ledger Foundation (PR #88) — MERGED                                │
└──────────────────────┬──────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PR 8B-1: Campaign Data Foundation & CRUD APIs (Persistence Slice)            │
│ - Migration 0051: `campaigns`, `campaign_recipients`, `messages.campaign_id`│
│ - Model B RLS policies, indexes, composite tenancy FKs                      │
│ - Contracts & DTOs for Campaign CRUD and list filtering                     │
│ - Workspace-isolated endpoints: GET, POST, PATCH, DELETE                    │
│ - Replaces frontend mock fixtures with live database persistence            │
│ - DISPATCH DISABLED: Returns 501 / 400 with explicit blocker notice          │
│ - Dependencies: None (fully decoupled from Phase 7)                         │
└──────────────────────┬──────────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ PR 8B-2: Audience Materialization, Previews & Scheduling Validation         │
│ - Integration with Phase 8A-S `ContactsService.resolveAudience()`           │
│ - Accurate, defensible audience preview endpoint (no fabricated counts)     │
│ - Keyset streaming audience materialization into `campaign_recipients`      │
│ - Deduplication invariant: UNIQUE(campaign_id, contact_id)                  │
│ - Campaign lifecycle FSM: draft ↔ scheduled, validation guards              │
│ - Template channel compatibility and variable validation                    │
│ - DISPATCH DISABLED: Pre-execution readiness achieved                      │
│ - Dependencies: PR 8B-1, Phase 8A-S                                         │
└──────────────────────┬──────────────────────────────────────────────────────┘
                       │
                       ▼  ◄── GATE: Phase 7.2 (Pricing), Phase 7.3 (Send Core),
                       │            Gate 7-A Approval, and Owner Authorization
┌─────────────────────────────────────────────────────────────────────────────┐
│ PR 8B-3: Billing-Aware Orchestrator & Campaign Execution                    │
│ - Pre-dispatch bulk wallet/credit reservation check                         │
│ - Integration with PR 7-3 shared send core (`MessagesService.sendMessage`)   │
│ - Database-backed concurrency poller (`SKIP LOCKED`) for scheduled execution│
│ - Rate-limited dispatch worker respecting `throttling.rateLimitPerSecond`   │
│ - Live recipient status progression and delivery metric rollups             │
│ - Pause, resume, and cancel operational controls                            │
│ - Dependencies: PR 8B-2, PR 7-2, PR 7-3, Gate 7-A                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Database Schema & Migration Proposal

### 2.1 Schema Design (`packages/db/src/schema/campaigns.ts`)

```typescript
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';
import { channels } from './providers';
import { templates } from './templates';
import { contacts, contactIdentities } from './contacts';
import { users } from './iam';
import { messages } from './messages';

/** Campaign lifecycle status machine. */
export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
]);

/** Scheduling mode. */
export const campaignScheduleMode = pgEnum('campaign_schedule_mode', [
  'immediate',
  'scheduled',
]);

/** Recipient source specification type. */
export const campaignRecipientSourceType = pgEnum('campaign_recipient_source_type', [
  'all_contacts',
  'tag_segment',
  'custom_list',
]);

/** Recipient dispatch lifecycle status. */
export const campaignRecipientStatus = pgEnum('campaign_recipient_status', [
  'pending',
  'enqueued',
  'sent',
  'skipped',
  'failed',
]);

/**
 * Campaigns Table (Phase 8B, DATABASE.md §8).
 * Tenant-content table protected by Model B RLS.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'restrict' }),
    templateVariables: jsonb('template_variables')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: campaignStatus('status').notNull().default('draft'),
    recipientSource: jsonb('recipient_source').notNull(),
    scheduleMode: campaignScheduleMode('schedule_mode').notNull().default('immediate'),
    scheduledAt: tstz('scheduled_at'),
    throttling: jsonb('throttling')
      .notNull()
      .default(sql`'{"rateLimitPerSecond": 25, "maxAttemptsPerRecipient": 1}'::jsonb`),
    routingPolicyId: uuid('routing_policy_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'restrict' }),
    metrics: jsonb('metrics')
      .notNull()
      .default(
        sql`'{"totalRecipients": null, "sent": 0, "delivered": 0, "read": 0, "failed": 0, "deliveryRate": 0}'::jsonb`,
      ),
    startedAt: tstz('started_at'),
    completedAt: tstz('completed_at'),
    deletedAt: tstz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'campaigns_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    unique('uq_campaigns_id_org_id').on(table.id, table.orgId),
    index('campaigns_org_workspace_status_idx').on(table.orgId, table.workspaceId, table.status),
    index('campaigns_scheduled_idx')
      .on(table.status, table.scheduledAt)
      .where(sql`${table.status} = 'scheduled' AND ${table.deletedAt} IS NULL`),
    index('campaigns_org_id_id_desc_idx').on(table.orgId, table.id.desc()),
  ],
);

/**
 * Campaign Recipients Table (Phase 8B, DATABASE.md §8).
 * Stores materialized intended audience members, status, and message lineage.
 */
export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: primaryId(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'restrict' }),
    identityId: uuid('identity_id')
      .references(() => contactIdentities.id, { onDelete: 'set null' }),
    status: campaignRecipientStatus('status').notNull().default('pending'),
    messageId: uuid('message_id')
      .references(() => messages.id, { onDelete: 'restrict' }),
    skipReason: text('skip_reason'),
    errorCode: text('error_code'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'campaign_recipients_campaign_org_fk',
      columns: [table.campaignId, table.orgId],
      foreignColumns: [campaigns.id, campaigns.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'campaign_recipients_contact_workspace_org_fk',
      columns: [table.contactId, table.workspaceId, table.orgId],
      foreignColumns: [contacts.id, contacts.workspaceId, contacts.orgId],
    }).onDelete('restrict'),
    // Deduplication Invariant: A contact can only appear once per campaign
    uniqueIndex('uq_campaign_recipients_campaign_contact').on(table.campaignId, table.contactId),
    index('campaign_recipients_campaign_status_idx').on(table.campaignId, table.status),
    index('campaign_recipients_message_id_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
  ],
);
```

### 2.2 Alteration to `messages` Table
```sql
-- Migration 0051 addition: Direct campaign attribution on core messages
ALTER TABLE messages
  ADD COLUMN campaign_id UUID REFERENCES campaigns(id) ON DELETE RESTRICT;

CREATE INDEX messages_org_campaign_idx
  ON messages(org_id, campaign_id)
  WHERE campaign_id IS NOT NULL;
```

### 2.3 Row-Level Security (Model B Enforcement)
In accordance with `TENANCY.md` §3a and `DATABASE.md` §14a:
```sql
-- Enable Model B Tenant RLS
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY campaigns_tenant_isolation ON campaigns
  FOR ALL
  USING (app_content_context_valid(org_id, workspace_id))
  WITH CHECK (app_content_context_valid(org_id, workspace_id));

CREATE POLICY campaign_recipients_tenant_isolation ON campaign_recipients
  FOR ALL
  USING (app_content_context_valid(org_id, workspace_id))
  WITH CHECK (app_content_context_valid(org_id, workspace_id));
```

---

## 3. API Contracts Aligned with Frontend

The API contracts directly implement the endpoints expected by the existing frontend slice (`apps/web/src/lib/campaigns.ts` and `apps/web/src/lib/api-client.ts`):

### 3.1 Endpoints Specification

| Method | Path | Required Permission | Description |
|---|---|---|---|
| `GET` | `/workspaces/:workspaceId/campaigns` | `campaigns.read` | List campaigns with status/channel filters and pagination |
| `POST` | `/workspaces/:workspaceId/campaigns` | `campaigns.manage` | Create new campaign in `draft` state |
| `GET` | `/workspaces/:workspaceId/campaigns/:id` | `campaigns.read` | Get campaign detail, configuration, and KPIs |
| `PATCH` | `/workspaces/:workspaceId/campaigns/:id` | `campaigns.manage` | Update draft/scheduled campaign parameters |
| `DELETE` | `/workspaces/:workspaceId/campaigns/:id` | `campaigns.manage` | Soft-delete draft campaign |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/audience-preview` | `campaigns.read` | Dynamic real audience preview via Phase 8A-S |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/schedule` | `campaigns.manage` | Materialize audience and transition to `scheduled` |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/cancel` | `campaigns.manage` | Cancel scheduled or running campaign |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/pause` | `campaigns.manage` | Pause running campaign enqueuing |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/resume` | `campaigns.manage` | Resume paused campaign enqueuing |
| `POST` | `/workspaces/:workspaceId/campaigns/:id/dispatch` | `campaigns.manage` | Immediate dispatch (Disabled in PR 8B-1/8B-2) |

### 3.2 Data Transfer Objects (`packages/contracts/src/campaigns.ts`)

```typescript
export interface CreateCampaignDto {
  name: string;
  description?: string;
  channel: 'whatsapp' | 'sms' | 'email' | 'rcs';
  templateId: string;
  templateVariables?: Record<string, string>;
  recipientSource: {
    type: 'all_contacts' | 'tag_segment' | 'custom_list';
    tag?: string;
    tags?: string[];
    tagMatchMode?: 'any' | 'all';
    requireOptIn?: boolean;
    segmentName?: string;
  };
  scheduleMode: 'immediate' | 'scheduled';
  scheduledAt?: string | null;
  throttling?: {
    rateLimitPerSecond?: number;
    maxAttemptsPerRecipient?: number;
  };
}

export interface CampaignRecordResponse {
  id: string;
  orgId: string;
  workspaceId: string;
  name: string;
  description?: string;
  channel: 'whatsapp' | 'sms' | 'email' | 'rcs';
  channelId: string;
  templateId: string;
  templateName: string;
  templateBody: string;
  templateVariables?: Record<string, string>;
  status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'cancelled';
  recipientSource: {
    type: 'all_contacts' | 'tag_segment' | 'custom_list';
    tag?: string;
    tags?: string[];
    tagMatchMode?: 'any' | 'all';
    contactCount: number | null;
    segmentName?: string;
  };
  scheduleMode: 'immediate' | 'scheduled';
  scheduledAt: string | null;
  throttling: {
    rateLimitPerSecond: number;
    maxAttemptsPerRecipient: number;
  };
  metrics: {
    totalRecipients: number | null;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    deliveryRate: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  isSimulatedPreview?: false;
}
```

---

## 4. Integration with Phase 8A-S Audience Resolution

Phase 8B leverages `ContactsService.resolveAudience()` (merged in PR #89) for two distinct operational phases:

### 4.1 On-Demand Audience Preview (Read-Only)
When a user views the campaign creation modal or the campaign audience tab:
- Frontend requests `POST /workspaces/:workspaceId/campaigns/:id/audience-preview`.
- Campaign service invokes `ContactsService.resolveAudience`:
  ```typescript
  const audience = await this.contactsService.resolveAudience(principal, {
    channel: campaign.channel,
    tags: campaign.recipientSource.tags ?? (campaign.recipientSource.tag ? [campaign.recipientSource.tag] : undefined),
    tagMatchMode: campaign.recipientSource.tagMatchMode ?? 'any',
    requireOptIn: campaign.recipientSource.requireOptIn ?? false,
    limit: 10, // Preview slice
  }, workspaceId);
  ```
- **Defensible Count Guarantee:** Returns `audience.totalCount` directly from `SELECT count(DISTINCT contacts.id)::int`. Zero estimation or fabrication.

### 4.2 Audience Materialization (Pre-Execution Snapshotting)
Per `ARCHITECTURE.md` §11, before execution begins, the campaign audience is frozen into `campaign_recipients`:
1. The service streams all matching contacts using `CursorCodec` keyset pagination in batches (e.g. 1,000 contacts/batch).
2. Performs batch insert:
   ```sql
   INSERT INTO campaign_recipients (
     id, campaign_id, org_id, workspace_id, contact_id, identity_id, status, skip_reason, created_at, updated_at
   ) VALUES (...)
   ON CONFLICT (campaign_id, contact_id) DO NOTHING;
   ```
3. Identifies and marks skipped contacts upfront:
   - If contact has no active identity for channel: `status = 'skipped', skip_reason = 'no_active_identity'`.
   - If contact identity is suppressed: `status = 'skipped', skip_reason = 'actively_suppressed'`.
   - If contact lacks required opt-in: `status = 'skipped', skip_reason = 'consent_opt_in_required'`.
4. Updates `campaigns.metrics.totalRecipients` to the exact materialized count.

---

## 5. Campaign Lifecycle & Scheduling Architecture

### 5.1 Lifecycle Finite State Machine (FSM)

```
        ┌────────────────────────────────────────────────────────┐
        │                                                        │
        ▼                                                        │
    ┌──────────┐  Schedule & Materialize   ┌───────────┐         │ Un-schedule
    │  draft   ├──────────────────────────►│ scheduled ├─────────┘
    └────┬─────┘                           └─────┬─────┘
         │ Immediate Dispatch (PR 8B-3)          │ Due Time Reached
         │                                       ▼
         │                                 ┌───────────┐
         └────────────────────────────────►│  running  │◄────────┐
                                           └─────┬─────┘         │ Resume
                                                 │               │
                                           Pause │         ┌─────┴─────┐
                                                 ├────────►│  paused   │
                                                 │         └───────────┘
                                                 ▼
                                           ┌───────────┐
                                           │ completed │ (Terminal)
                                           └───────────┘
```
- **Cancel Transition:** Permitted from `draft`, `scheduled`, `paused`, or `running` to terminal `cancelled`.
- **Terminal States:** `completed` and `cancelled` are strictly immutable.

### 5.2 Scheduling Engine Implementation
1. **Validation at Transition:**
   - `scheduledAt` must be in the future (minimum 60s from `now()`).
   - Bound template must exist, belong to the same organization, and match the campaign channel.
   - Materialized dispatchable audience must be > 0.
2. **Scheduler Concurrency Control:**
   - Background poller executes every 10–30 seconds.
   - Uses PostgreSQL `FOR UPDATE SKIP LOCKED` to prevent duplicate triggering across multiple API replicas:
     ```sql
     SELECT id, org_id, workspace_id, throttling
     FROM campaigns
     WHERE status = 'scheduled'
       AND scheduled_at <= now()
       AND deleted_at IS NULL
     FOR UPDATE SKIP LOCKED
     LIMIT 10;
     ```
   - Sets `status = 'running', started_at = now()` atomically.

---

## 6. Integration with Shared Phase 7 Send Core (PR 7-3)

### 6.1 Strict Architectural Separation
- **No Private Send Engine:** The campaign module does NOT create `messages` rows directly, bypass RLS, or interact directly with provider adapters.
- **Campaign as Caller:** The campaign worker delegates every individual recipient send to the shared core:
  ```typescript
  // Called per recipient by Campaign Dispatch Worker
  await this.messagesService.sendMessage(principal, {
    recipient: recipient.identityAddress,
    channelCode: campaign.channel,
    templateId: campaign.templateId,
    templateVariables: mergedVariables,
    workspaceId: campaign.workspaceId,
    campaignId: campaign.id, // Direct correlation
    idempotencyKey: `campaign:${campaign.id}:recipient:${recipient.id}`,
  });
  ```

### 6.2 Pre-Dispatch Bulk Wallet Reservation (Phase 7 Dependency)
Before dispatching a campaign in PR 8B-3:
1. **Worst-Case Cost Estimation:**  
   $$\text{Estimated Exposure} = \text{Dispatchable Recipients} \times \text{Max Unit Price (from Phase 7.2 Rating Engine)}$$
2. **Preflight Funds Verification:**  
   Queries `wallets` or `credit_accounts` (from PR 7-1, migration `0050`):
   $$\text{Available Funds} = \text{balance\_paise} - \text{reserved\_paise} \ge \text{Estimated Exposure}$$
3. **Chunked Reservation (Recommended):**  
   Rather than locking an entire organization's wallet for a multi-hour campaign, the campaign worker reserves funds in chunks (e.g. 1,000 recipients at a time) via `app_ledger_post('reservation')`.
4. **Insufficient Funds Handling:**  
   If available funds are exhausted mid-campaign, the campaign transitions to `paused` with `skip_reason = 'insufficient_funds'`. Already submitted messages proceed to normal settlement.

---

## 7. Security, Invariants & Acceptance Testing

### 7.1 Security & Multi-Tenant Invariants
1. **Model B RLS Enforcement:** Campaigns and recipient rows are strictly isolated at both organization and workspace boundaries.
2. **Deterministic Context Fail-Closed:** Missing auth, missing session org, or mismatched workspace context returns 400, 401, 403, or 404.
3. **Mandatory Consent & Suppression Verification:** The campaign engine cannot bypass suppression lists or revoked consent.
4. **Idempotency Guard:** Every recipient send carries a deterministic idempotency key (`campaign:{campaignId}:recipient:{recipientId}`). Network retries or worker restarts cannot create duplicate messages.

### 7.2 Acceptance Test Matrix by PR

#### PR 8B-1: Data Foundation & CRUD
- Unit tests for DTO validation pipes and default throttling bounds.
- Database tests verifying composite foreign keys, unique constraints, and Model B RLS isolation.
- Integration tests verifying `GET /workspaces/:workspaceId/campaigns` filtering by channel, status, and search query.
- Security tests verifying cross-tenant 404s and rejection of foreign workspace IDs.

#### PR 8B-2: Audience Materialization & Previews
- Integration tests with `ContactsService.resolveAudience()` asserting exact count parity.
- Deduplication tests proving `UNIQUE(campaign_id, contact_id)` prevents duplicate recipients.
- Lifecycle transition tests verifying valid state changes and rejection of invalid jumps (e.g. `completed` -> `draft`).
- Scheduling validation tests rejecting past timestamps and unmatched channel templates.

#### PR 8B-3: Execution & Billing
- Billing preflight tests verifying campaign pauses on insufficient wallet balance.
- Concurrency tests verifying `SKIP LOCKED` prevents duplicate worker execution across replicas.
- Throttling rate-limit tests verifying dispatch adheres to `rateLimitPerSecond`.
- Full end-to-end delivery outcome rollup tests verifying metrics counters (`sent`, `delivered`, `failed`).

---

## 8. Exact Blockers & Owner Decisions

The following items require explicit Owner Decision before beginning implementation:

### OD-8B-1: Campaign Permissions Catalogue
- **Context:** The frontend currently checks `useCanReadCampaigns()` and `useCanManageCampaigns()` mapped provisionally to `messages.read` and `messages.send`.
- **Options:**
  - *Option A (Recommended):* Introduce dedicated `campaigns.read` and `campaigns.manage` keys in `packages/contracts/src/permissions.ts` with allowed scopes `{organization, workspace}`.
  - *Option B:* Retain `messages.read` and `messages.send` without adding new permission keys.
- **Recommendation:** **Option A**. Dedicated permissions maintain least privilege, allowing organization admins to appoint campaign creators without granting raw API key message dispatch rights.

### OD-8B-2: Audience Materialization Timing
- **Context:** `ARCHITECTURE.md` §11 specifies materializing `campaign_recipients` before sending.
- **Options:**
  - *Option A (Recommended):* Eager materialization upon transitioning to `scheduled` or confirming launch.
  - *Option B:* Lazy materialization at worker execution time.
- **Recommendation:** **Option A**. Eager materialization freezes an immutable, auditable recipient list, enables accurate pre-send progress reporting, and sizes pre-dispatch wallet reservations accurately.

### OD-8B-3: Phase 7 Gate 7-A & Send Core Dependency
- **Context:** Campaign dispatch requires financial reservation and rating.
- **Decision:** Split Phase 8B into two gates:
  - **Phase 8B.1 (PR 8B-1 + PR 8B-2):** Authorized immediately. Unblocks live campaign creation, template binding, and audience previews. Dispatch remains disabled.
  - **Phase 8B.2 (PR 8B-3):** Authorized only after Phase 7.2, Phase 7.3, and Gate 7-A are accepted.

---

## Summary of Handover Artifacts

| Artifact | Path |
|---|---|
| Master Handover Document | `docs/PHASE-8B-CAMPAIGNS-BACKEND-HANDOVER.md` |
| Authoritative Contracts | `packages/contracts/src/contacts.ts` (Phase 8A-S) |
| Authoritative Frontend Slice | `apps/web/src/lib/campaigns.ts`, `apps/web/src/lib/api-client.ts` |
| Ledger Baseline Reference | `packages/db/migrations/0050_phase7_1_ledger_foundation.sql` |
