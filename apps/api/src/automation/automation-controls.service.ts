import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import type { Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AppException } from '../common/errors/app.exception';
import { TenantDatabase } from '../database/tenant-database.service';
import { requireOrganization } from '../workspaces/workspace-administration.service';

export type AutomationControlAction = 'pause' | 'resume' | 'revoke';

export interface AutomationControlView {
  readonly orgId: string;
  readonly sendingPaused: boolean;
  readonly pausedAt: string | null;
  readonly pauseReason: string | null;
  readonly revokedBefore: string | null;
}

const AUDIT_ACTION: Record<AutomationControlAction, string> = {
  pause: 'automation.paused',
  resume: 'automation.resumed',
  revoke: 'automation.revoked',
};

/**
 * Phase 8B PR 8B-3a: the organisation-wide automation controls (PHASE-8B-3-HANDOVER-Rev2 §3.5,
 * owner decision OD-8B3-5, clarification C-1).
 *
 * Authority is organisation-wide, so every action asserts `campaigns.manage` with the
 * **organisation** as the target: a grant held only at a workspace (or team) never covers it
 * (`scopeCovers`: a grant never reaches above its own level). User sessions only — an API key is
 * refused. The database re-checks the same rule (`app_automation_org_authority()`) before the
 * definer applies the control under FOR UPDATE on the organisation's control row, which every
 * send holds FOR SHARE: no send can be authorised after the control has committed.
 */
@Injectable()
export class AutomationControlsService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async status(principal: AuthPrincipal): Promise<AutomationControlView> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.assertOrganizationAuthority(tx, principal, orgId);
      const { rows } = await tx.execute<{
        sending_paused: boolean;
        paused_at: Date | null;
        pause_reason: string | null;
        revoked_before: Date | null;
      }>(sql`SELECT * FROM app_automation_control_status()`);
      const row = rows[0];
      if (!row) throw forbidden();
      return view(orgId, row);
    });
  }

  async apply(
    principal: AuthPrincipal,
    action: AutomationControlAction,
    reason: string | undefined,
  ): Promise<AutomationControlView> {
    const orgId = requireOrganization(principal);
    return this.db.withRequestTenant(async (tx) => {
      await this.assertOrganizationAuthority(tx, principal, orgId);
      const before = await this.current(tx);
      let applied: { revoked_count: number };
      try {
        const { rows } = await tx.execute<{ revoked_count: number }>(
          sql`SELECT * FROM app_automation_control(${action}, ${reason ?? null})`,
        );
        applied = rows[0]!;
      } catch (error) {
        if (pgCode(error) === '42501') throw forbidden();
        throw error;
      }
      const after = await this.current(tx);
      await this.audit.record(
        {
          scopeType: 'organization',
          scopeId: orgId,
          ...actorFromPrincipal(principal),
          action: AUDIT_ACTION[action],
          resourceType: 'Organization',
          resourceId: orgId,
          outcome: 'success',
          before: { sendingPaused: before.sending_paused },
          after: { sendingPaused: after.sending_paused },
          metadata: {
            reason: reason ?? null,
            ...(action === 'revoke' ? { revokedCapabilities: Number(applied.revoked_count) } : {}),
          },
        },
        tx,
      );
      return view(orgId, after);
    });
  }

  /** `campaigns.manage` at the ORGANISATION target, user sessions only (C-1). */
  private async assertOrganizationAuthority(
    tx: Transaction,
    principal: AuthPrincipal,
    orgId: string,
  ): Promise<void> {
    if (principal.apiKeyId) throw forbidden();
    await this.authorization.assert(tx, {
      principal,
      permission: PERMISSIONS.CAMPAIGNS_MANAGE,
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Organization',
    });
  }

  private async current(tx: Transaction) {
    const { rows } = await tx.execute<{
      sending_paused: boolean;
      paused_at: Date | null;
      pause_reason: string | null;
      revoked_before: Date | null;
    }>(sql`SELECT * FROM app_automation_control_status()`);
    const row = rows[0];
    if (!row) throw forbidden();
    return row;
  }
}

function view(
  orgId: string,
  row: {
    sending_paused: boolean;
    paused_at: Date | null;
    pause_reason: string | null;
    revoked_before: Date | null;
  },
): AutomationControlView {
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    orgId,
    sendingPaused: row.sending_paused,
    pausedAt: iso(row.paused_at),
    pauseReason: row.pause_reason,
    revokedBefore: iso(row.revoked_before),
  };
}

function forbidden(): AppException {
  return new AppException({
    status: HttpStatus.FORBIDDEN,
    code: ERROR_CODES.AUTHZ_PERMISSION_DENIED,
    message: 'Organization-wide automation controls require campaigns.manage at organization scope',
  });
}

function pgCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
