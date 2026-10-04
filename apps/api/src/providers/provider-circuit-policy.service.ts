import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ERROR_CODES,
  PERMISSIONS,
  PROVIDER_CIRCUIT_POLICY_FIELDS,
  type AuthPrincipal,
  type ProviderCircuitPolicy,
} from '@acc/contracts';
import { schema } from '@acc/db';
import { eq } from 'drizzle-orm';

import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { TenantDatabase } from '../database/tenant-database.service';
import { ProviderAccess } from './provider-access.service';
import {
  circuitPolicyOf,
  circuitPolicyView,
  loadCircuitPolicy,
  type CircuitPolicyView,
} from './provider-views';
import type { UpdateCircuitPolicyDto } from './provider.dto';

/**
 * The platform circuit policy (Gate D.3 remediation, `PROVIDER_ADAPTER.md`
 * §6a, §6i): read and replaced by `providers.manage` at platform scope, as
 * every catalogue write is (`ProviderAccess`).
 *
 * **Concurrency-safe.** The update locks the policy row, compares the caller's
 * `expectedVersion` with the stored one and writes only on a match, advancing
 * the version by one (the database refuses any other step). A stale version is
 * `409 RESOURCE_CONFLICT` naming the current one; of two concurrent updates from
 * one version exactly one succeeds. Re-sending the policy already in force
 * changes and records nothing.
 *
 * **Effect.** A committed change governs every circuit decision made after it:
 * each decision reads the policy under its provider row lock (§6a).
 */
@Injectable()
export class ProviderCircuitPolicyService {
  private readonly logger = new Logger(ProviderCircuitPolicyService.name);

  constructor(
    private readonly db: TenantDatabase,
    private readonly access: ProviderAccess,
  ) {}

  async get(principal: AuthPrincipal): Promise<CircuitPolicyView> {
    return this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      return circuitPolicyView(await loadCircuitPolicy(tx));
    });
  }

  async update(
    principal: AuthPrincipal,
    input: UpdateCircuitPolicyDto,
  ): Promise<CircuitPolicyView> {
    const next = Object.fromEntries(
      PROVIDER_CIRCUIT_POLICY_FIELDS.map((field) => [field, input[field]]),
    ) as unknown as ProviderCircuitPolicy;
    const view = await this.db.withRequestTenant(async (tx) => {
      await this.access.authorize(tx, principal, PERMISSIONS.PROVIDERS_MANAGE);
      if (next.minSamples > next.windowMaxSamples) {
        throw new AppException({
          status: HttpStatus.BAD_REQUEST,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'The circuit policy is not valid',
          details: {
            issues: [
              {
                field: 'minSamples',
                rule: 'MIN_SAMPLES_ABOVE_MAX',
                message: 'minSamples must not exceed windowMaxSamples',
              },
            ],
          },
        });
      }
      const current = await loadCircuitPolicy(tx, { forUpdate: true });
      if (current.version !== input.expectedVersion) {
        throw new AppException({
          status: HttpStatus.CONFLICT,
          code: ERROR_CODES.RESOURCE_CONFLICT,
          message: 'The circuit policy has changed since that version',
          // Readable through GET by the same principal, so naming it discloses nothing.
          details: { currentVersion: current.version },
        });
      }
      const before = circuitPolicyOf(current);
      if (PROVIDER_CIRCUIT_POLICY_FIELDS.every((f) => before[f] === next[f])) {
        return { view: circuitPolicyView(current), changed: false as const };
      }
      const [row] = await tx
        .update(schema.providerCircuitPolicy)
        .set({ ...next, version: current.version + 1 })
        .where(eq(schema.providerCircuitPolicy.scope, 'platform'))
        .returning();
      await this.access.recordCircuitPolicy(
        tx,
        principal,
        { ...before, version: current.version },
        { ...next, version: row!.version },
      );
      return { view: circuitPolicyView(row!), changed: true as const };
    });
    if (view.changed) {
      this.logger.warn({
        msg: 'provider circuit policy changed',
        version: view.view.version,
        correlationId: RequestContext.correlationId(),
      });
    }
    return view.view;
  }
}
