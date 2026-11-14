import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PERMISSIONS } from '@acc/contracts';

import { AuthorizationService } from '../src/auth/authorization.service';
import { RequiresPermission } from '../src/auth/requires-permission.decorator';
import { RequestContext } from '../src/common/context/request-context';
import { TenantDatabase } from '../src/database/tenant-database.service';
import { MessageSubmissionCore } from '../src/messages/submission/message-submission.core';
import { authorizeSubmission } from '../src/messages/submission/submission-authorization';
import type { SubmissionRequest } from '../src/messages/submission/submission.types';
import { requireOrganization } from '../src/workspaces/workspace-administration.service';
import { requestPrincipal } from '../src/workspaces/workspaces.controller';

interface ProbeBody {
  readonly journeyId: string;
  readonly executionId: string;
  readonly request: SubmissionRequest;
}

/**
 * Phase 8C-5a — TEST ONLY. Registered solely through `startHarness({ controllers })` in
 * `journeys-send-attribution.int-spec.ts`; it is not part of any application module, and it
 * is not a journey execution path: production code constructs no `SubmissionOrigin` until
 * the 8C-5b send port (inert until 8C-6).
 *
 * It drives the shared core exactly as `POST /messages` does — the caller's authenticated
 * `acc_app` tenant transaction and a `messages.send` proof minted in it — and adds a journey
 * origin taken from the body, so the database (the composite foreign key) is what accepts or
 * refuses the attribution. A refusal is returned as its SQLSTATE and constraint.
 */
@Controller('test-journey-origin')
export class JourneyOriginProbeController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequiresPermission(PERMISSIONS.MESSAGES_SEND, {
    target: 'deferred',
    because: 'the target is the request organization',
  })
  async submit(@Body() body: ProbeBody) {
    const db = this.moduleRef.get(TenantDatabase, { strict: false });
    const authorizationService = this.moduleRef.get(AuthorizationService, { strict: false });
    const core = this.moduleRef.get(MessageSubmissionCore, { strict: false });
    const principal = requestPrincipal();
    const orgId = requireOrganization(principal);
    try {
      const result = await db.withRequestTenant(async (tx) => {
        const authorization = await authorizeSubmission(authorizationService, tx, principal, orgId);
        return core.submit(
          tx,
          {
            orgId,
            correlationId: RequestContext.correlationId(),
            authorization,
            origin: { kind: 'journey', journeyId: body.journeyId, executionId: body.executionId },
          },
          body.request,
        );
      });
      return { messageId: result.messageId };
    } catch (error) {
      const pg = pgError(error);
      if (!pg) throw error;
      return { refused: pg };
    }
  }
}

function pgError(error: unknown): { code: string; constraint: string | null } | null {
  for (let e: unknown = error; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))
      return { code, constraint: typeof constraint === 'string' ? constraint : null };
  }
  return null;
}
