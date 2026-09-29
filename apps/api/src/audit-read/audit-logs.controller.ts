import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { ListAuditLogsQueryDto } from './audit-log.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { AuditReadService } from './audit-read.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiPaged } from '../openapi/openapi-responses';
import { AuditLogSchema } from '../openapi/openapi-schemas';

/**
 * Audit read (`API.md` §3f, Phase 1B.6.3).
 *
 * Read-only by construction and by grant: there is no `POST`, `PATCH` or
 * `DELETE` here, and `acc_app` holds no `UPDATE`/`DELETE`/`TRUNCATE` on
 * `audit_logs` (migration `0001`), so the append-only guarantee does not depend
 * on this controller's restraint.
 *
 * Both handlers follow the established shape — resolve the principal, open one
 * tenant transaction, delegate — so the authorization decision and the query run
 * under the same `SET LOCAL` context and RLS filters what the decision admitted.
 */
@ApiTags('audit-logs')
@Controller('audit-logs')
export class AuditLogsController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly audit: AuditReadService,
  ) {}

  private principal(): ResolvedPrincipal {
    const principal = RequestContext.get()?.principal as ResolvedPrincipal | null | undefined;
    if (!principal) {
      throw new AppException({
        status: HttpStatus.UNAUTHORIZED,
        code: ERROR_CODES.AUTH_CREDENTIAL_REQUIRED,
        message: 'Authentication is required',
      });
    }
    return principal;
  }

  @Get()
  @RequiresPermission(PERMISSIONS.AUDIT_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List audit records' })
  @ApiPaged(AuditLogSchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListAuditLogsQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.audit.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.AUDIT_READ, {
    target: 'deferred',
    because:
      'the target is the scope the record was written at, knowable only once the row is loaded — ' +
      'a row recorded at a workspace is a workspace resource, not an organization one',
  })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get an audit record' })
  @ApiData(AuditLogSchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.audit.get(tx, principal, id));
    return { data };
  }
}
