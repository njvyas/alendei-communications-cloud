import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { CreateAssignmentDto, ListAssignmentsQueryDto } from './role-assignment.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { RoleAssignmentService } from './role-assignment.service';

/**
 * Role-assignment administration (`API.md` §3c, Phase 1B.5.5).
 *
 * Every handler resolves the principal, opens one tenant transaction and
 * delegates — the authorization decisions, the escalation guards and the audit
 * row all live in the service, inside that transaction, so a grant and its
 * record share a fate and no handler carries a decision of its own.
 *
 * Response shapes follow the conventions in use today; pagination, filtering
 * beyond the three parameters `API.md` §3c names, and envelope normalization
 * are Phase 1B.5.8's.
 */
@Controller('role-assignments')
export class RoleAssignmentsController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly assignments: RoleAssignmentService,
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
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_READ)
  async list(@Query() query: ListAssignmentsQueryDto) {
    const principal = this.principal();
    const assignments = await this.db.withRequestTenant((tx) =>
      this.assignments.list(tx, principal, query),
    );
    return { assignments };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_READ)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    return this.db.withRequestTenant((tx) => this.assignments.get(tx, principal, id));
  }

  @Post()
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_GRANT, {
    target: 'deferred',
    because:
      'the target is the scope named in the body, which no route metadata can know — ' +
      'guessing it would be the forged-target defect ADR-005 D-5 exists to prevent',
  })
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateAssignmentDto) {
    const principal = this.principal();
    return this.db.withRequestTenant((tx) =>
      this.assignments.grant(tx, principal, {
        userId: dto.userId,
        roleId: dto.roleId,
        scopeType: dto.scopeType,
        scopeId: dto.scopeId,
      }),
    );
  }

  @Delete(':id')
  @RequiresPermission(PERMISSIONS.ROLE_ASSIGNMENTS_REVOKE, {
    target: 'deferred',
    because: 'the target is the scope on the stored row, knowable only once it is loaded',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    await this.db.withRequestTenant((tx) => this.assignments.revoke(tx, principal, id));
  }
}
