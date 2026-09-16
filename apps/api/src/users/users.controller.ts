import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ERROR_CODES, PERMISSIONS } from '@acc/contracts';
import type { Response } from 'express';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { TenantDatabase } from '../database/tenant-database.service';
import type { ResolvedPrincipal } from '../auth/auth.guard';
import { CreateUserDto, ListUsersQueryDto, UpdateUserDto } from './user.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { UserAdministrationService } from './user-administration.service';

/**
 * User administration (`API.md` §3d, Phase 1B.6.1).
 *
 * Every handler is the same three lines as the rest of the administration
 * surface: resolve the principal, open one tenant transaction, delegate. The
 * authorization decision, the lifecycle guards and the audit row all live in the
 * service, inside that transaction, so a mutation and its record share a fate
 * and no handler carries a decision of its own (ADR-005 D-1, D-5).
 *
 * **Lifecycle is two explicit operations, not a status field.** `POST
 * /users/:id/disable` and `POST /users/:id/reactivate` exist rather than
 * `PATCH { status }` because they are not profile edits: one revokes live
 * access and is bounded by the platform-admin liveness invariant, the other
 * restores it. Each declares its own permission and writes its own audit
 * action, which a generic field update could not.
 *
 * **There is no `DELETE`.** `acc_app` holds no delete grant on `users`
 * (migration `0000`), audit rows must outlive the identity they describe, and a
 * `DELETE` that answered `204` while disabling would be a lie in the route
 * table. Deactivation is the deletion semantics this system has.
 */
@Controller('users')
export class UsersController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly users: UserAdministrationService,
    private readonly idempotency: IdempotencyService,
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
  @RequiresPermission(PERMISSIONS.USERS_READ)
  async list(@Query() query: ListUsersQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.users.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.USERS_READ)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.users.get(tx, principal, id));
    return { data };
  }

  /**
   * Creates an identity and its first grant, at most once per `Idempotency-Key`
   * (`API.md` §4).
   *
   * The key is optional and earns its place here for the reason it does on
   * `POST /roles`: a duplicate address is already refused by a unique index, so
   * idempotency does not make an unsafe endpoint safe — it makes a *successful
   * retry* distinguishable from a genuine duplicate. Without it a client whose
   * response was lost cannot tell whether it created the user or someone else
   * did, and the identity namespace is global, so guessing is expensive.
   *
   * `IdempotencyService.execute` opens the tenant transaction and hands the same
   * `tx` to the work, so authorization still runs inside the request's own
   * transaction before the mutation (ADR-005 D-5).
   */
  @Post()
  @RequiresPermission(PERMISSIONS.USERS_INVITE)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateUserDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = this.principal();
    const outcome = await this.idempotency.execute({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/users',
        orgId: principal.tenant.orgId,
        principal,
        pathParams: {},
        query: {},
        body: dto,
      },
      // The same check `create` performs, run before a replay is returned so a
      // stored response is never handed back on the strength of an old decision.
      authorize: (tx) => this.users.assertMayCreate(tx, principal),
      // The envelope, so the stored snapshot is byte-identical to what was sent.
      work: async (tx) => ({
        data: await this.users.create(tx, principal, {
          email: dto.email,
          phone: dto.phone ?? null,
          initialRole: {
            roleId: dto.initialRole.roleId,
            scopeType: dto.initialRole.scopeType,
            scopeId: dto.initialRole.scopeId,
          },
        }),
      }),
    });

    response.status(outcome.status);
    return outcome.body;
  }

  /**
   * Updates the supported profile attributes.
   *
   * No `Idempotency-Key`: a `PATCH` carrying the same body twice produces the
   * same state, and a key would buy the ability to replay a stored response —
   * which for an endpoint whose second execution is already harmless is
   * machinery without a hazard to protect against (`API.md` §4a).
   */
  @Patch(':id')
  @RequiresPermission(PERMISSIONS.USERS_UPDATE)
  async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateUserDto) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) =>
      this.users.update(tx, principal, id, 'phone' in dto ? { phone: dto.phone ?? null } : {}),
    );
    return { data };
  }

  /**
   * Disables a user.
   *
   * No `Idempotency-Key`, and here the reason is stronger than for `PATCH`: the
   * transition is its own answer. A second disable is `409
   * USER_LIFECYCLE_CONFLICT` naming the current status, which is a definite
   * result a retrying client can act on — replaying the first `200` instead
   * would tell it the transition happened now when it happened earlier.
   */
  @Post(':id/disable')
  @RequiresPermission(PERMISSIONS.USERS_DISABLE)
  @HttpCode(HttpStatus.OK)
  async disable(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.users.disable(tx, principal, id));
    return { data };
  }

  /** Restores a disabled user. Same reasoning on idempotency as `disable`. */
  @Post(':id/reactivate')
  @RequiresPermission(PERMISSIONS.USERS_REACTIVATE)
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.users.reactivate(tx, principal, id));
    return { data };
  }
}
