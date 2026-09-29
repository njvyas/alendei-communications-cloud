import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CreateApiKeyDto, ListApiKeysQueryDto } from './api-key.dto';
import { RequiresPermission } from '../auth/requires-permission.decorator';
import { IdempotencyKey } from '../idempotency/idempotency.decorator';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ApiKeyAdministrationService, type ApiKeyView } from './api-key-administration.service';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptedCredentials } from '../openapi/accepted-credentials.decorator';
import { ApiData, ApiErrors, ApiIdempotencyKey, ApiPaged } from '../openapi/openapi-responses';
import { ApiKeySchema, CreatedApiKeySchema } from '../openapi/openapi-schemas';

/** The creation envelope. `secret` is always present, and null on a replay. */
interface CreatedApiKeyBody {
  readonly data: ApiKeyView & { readonly secret: string | null };
}

/**
 * API-key administration (`API.md` §3e, Phase 1B.6.2).
 *
 * The same three lines per handler as the rest of the administration surface:
 * resolve the principal, open one tenant transaction, delegate. Authorization,
 * the lifecycle guards and the audit row live in the service, inside that
 * transaction, so a mutation and its record share a fate.
 *
 * **There is no `DELETE`.** Revocation is a lifecycle transition and is
 * terminal; a deleted row would take its audit attribution with it, and
 * `audit_logs.actor_api_key_id` references this table. There is likewise no
 * un-revoke and no rotation in this phase.
 */
@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeysController {
  constructor(
    private readonly db: TenantDatabase,
    private readonly apiKeys: ApiKeyAdministrationService,
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
  @RequiresPermission(PERMISSIONS.API_KEYS_READ)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'List API keys' })
  @ApiPaged(ApiKeySchema)
  @ApiErrors(400, 401, 403, 429)
  async list(@Query() query: ListApiKeysQueryDto) {
    const principal = this.principal();
    const { items, page } = await this.db.withRequestTenant((tx) =>
      this.apiKeys.list(tx, principal, query),
    );
    return { data: items, page };
  }

  @Get(':id')
  @RequiresPermission(PERMISSIONS.API_KEYS_READ, {
    target: 'deferred',
    because:
      "the target is the key's own stored binding scope, knowable only once the row is loaded — " +
      'a key bound to a workspace is a workspace resource, not an organization one',
  })
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Get an API key' })
  @ApiData(ApiKeySchema)
  @ApiErrors(400, 401, 403, 404, 429)
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.apiKeys.get(tx, principal, id));
    return { data };
  }

  /**
   * Mints a key, returning its plaintext secret **exactly once** (ADR-008).
   *
   * ---
   *
   * **The secret never enters the idempotency mechanism.** This is the whole of
   * ADR-008 and it is worth reading the shape rather than trusting the comment:
   *
   *   - `work()` returns the envelope with `secret: null`. That envelope — and
   *     only that envelope — is what `IdempotencyService.finalize` writes into
   *     `idempotency_keys.response_snapshot`.
   *   - The real plaintext is captured in `minted`, a local that lives on the
   *     stack of this one request and is never passed to the service, the
   *     writer, the logger or the database.
   *   - It is merged into the response **only** when `outcome.replayed` is
   *     false, which is true only on the execution that actually created the
   *     key.
   *
   * So a replay returns `secret: null`, because there is nowhere for a secret to
   * be replayed *from*. That is the correct reading of "presented exactly once",
   * not a degradation of it: a stored snapshot containing a live credential
   * would sit in a plaintext column that is never physically purged
   * (`DATABASE.md` §7.1), which is precisely the invariant ADR-008 protects.
   *
   * **Nothing about the 1B.5.9 mechanism is weakened.** The claim, the
   * fingerprint, the single transaction, the authorize-before-replay hook and
   * at-most-once execution are all untouched, and `IdempotencyService` itself is
   * unmodified — the field is kept out at the call site rather than by teaching
   * the mechanism to redact. Role and role-assignment idempotency behave exactly
   * as before.
   *
   * If a caller loses this response the secret is unrecoverable by design: there
   * is no retrieval endpoint, and the remedy is to revoke the key and create
   * another.
   */
  @Post()
  @RequiresPermission(PERMISSIONS.API_KEYS_CREATE, {
    target: 'deferred',
    because:
      'the target is the binding scope named in the body, which no route metadata can know — ' +
      'guessing it would be the forged-target defect ADR-005 D-5 exists to prevent',
  })
  @HttpCode(HttpStatus.CREATED)
  @AcceptedCredentials('userSession')
  @ApiIdempotencyKey()
  @ApiOperation({ summary: 'Create an API key' })
  @ApiData(CreatedApiKeySchema, { status: 201 })
  @ApiErrors(400, 401, 403, 404, 409, 422, 429)
  async create(
    @Body() dto: CreateApiKeyDto,
    @IdempotencyKey() idempotencyKey: string | null,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = this.principal();

    /**
     * The plaintext, for the duration of this request and no longer.
     *
     * Assigned only by a fresh execution of `work`. On a replay `work` never
     * runs, so this stays `null` and the stored envelope is returned unchanged.
     */
    let minted: string | null = null;

    const outcome = await this.idempotency.execute<CreatedApiKeyBody>({
      key: idempotencyKey,
      successStatus: HttpStatus.CREATED,
      request: {
        method: 'POST',
        route: '/api-keys',
        orgId: principal.tenant.orgId,
        principal,
        pathParams: {},
        query: {},
        body: dto,
      },
      // The same check `create` performs, against the same binding scope, run
      // before a replay is returned.
      authorize: (tx) =>
        this.apiKeys.assertMayCreate(tx, principal, {
          scopeType: dto.scopeType,
          scopeId: dto.scopeId,
        }),
      work: async (tx) => {
        const { view, secret } = await this.apiKeys.create(tx, principal, {
          name: dto.name,
          scopeType: dto.scopeType,
          scopeId: dto.scopeId,
          scopes: dto.scopes,
          expiresAt: dto.expiresAt ?? null,
        });
        minted = secret;
        // `secret: null` is what gets stored. The field is present rather than
        // omitted so the persisted and fresh envelopes have the same shape and
        // a client needs no separate branch to parse a replay.
        return { data: { ...view, secret: null } };
      },
    });

    response.status(outcome.status);
    if (outcome.replayed || minted === null) return outcome.body;
    return { data: { ...outcome.body.data, secret: minted } } satisfies CreatedApiKeyBody;
  }

  /**
   * Revokes a key. Terminal, and authorized against the key's **stored** binding
   * scope rather than anything the caller sent.
   *
   * No `Idempotency-Key`: a second revocation is `409
   * API_KEY_LIFECYCLE_CONFLICT` naming the current status, which is a definite
   * answer a retrying client can act on — and unlike the user lifecycle, the
   * conditional `WHERE revoked_at IS NULL` makes exactly one concurrent caller
   * the winner, so the conflict is deterministic rather than a race.
   */
  @Post(':id/revoke')
  @RequiresPermission(PERMISSIONS.API_KEYS_REVOKE, {
    target: 'deferred',
    because:
      "the target is the key's own stored binding scope, read from the row — authorizing against " +
      'a caller-supplied scope would let an actor revoke a key it does not cover',
  })
  @HttpCode(HttpStatus.OK)
  @AcceptedCredentials('userSession', 'apiKey')
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiData(ApiKeySchema)
  @ApiErrors(400, 401, 403, 404, 409, 429)
  async revoke(@Param('id', new ParseUUIDPipe()) id: string) {
    const principal = this.principal();
    const data = await this.db.withRequestTenant((tx) => this.apiKeys.revoke(tx, principal, id));
    return { data };
  }
}
