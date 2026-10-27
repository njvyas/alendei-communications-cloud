import {
  SIMULATOR_BEHAVIORS,
  SIMULATOR_BEHAVIOR_CAPABILITY,
  validateSimulatorBehaviorCapability,
  type AuthPrincipal,
} from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';
import type { ListQuery } from '../common/http/list-query';
import type { TenantDatabase } from '../database/tenant-database.service';
import type { ProviderSubmissionExecutor } from '../provider-adapters/submission-executor';
import type { ProviderAccess } from './provider-access.service';
import type { ProviderConfigurationCache } from './provider-configuration.cache';
import { ProviderRegistryService } from './provider-registry.service';
import type { ProviderStateStore } from './provider-state.store';

/**
 * QAF-003 (#21): `simulator_behavior` is a standard capability key, so a saved
 * value must be one of `SIMULATOR_BEHAVIORS`; any other is refused with the
 * same field-level `INVALID_VALUE` issue `rcs_message_types` uses.
 */

const INVALID_VALUES: [string, unknown][] = [
  ['an empty string', ''],
  ['an unsupported string', 'FAIL'],
  ['a lower-case behaviour', 'success'],
  ['a padded behaviour', ' SUCCESS'],
  ['null', null],
  ['an object', { behavior: 'SUCCESS' }],
  ['an array', ['SUCCESS']],
  ['the number 500', 500],
  ['the number 429', 429],
  ['a boolean', true],
];

describe('simulator_behavior capability (QAF-003, #21)', () => {
  it('is the standard key the dispatcher reads', () => {
    expect(SIMULATOR_BEHAVIOR_CAPABILITY).toBe('simulator_behavior');
  });

  describe('validateSimulatorBehaviorCapability', () => {
    it.each(SIMULATOR_BEHAVIORS.map((b) => [b]))('accepts %s', (value) => {
      expect(validateSimulatorBehaviorCapability(value)).toEqual({ valid: true, errors: [] });
    });

    it.each(INVALID_VALUES)('refuses %s', (_label, value) => {
      expect(validateSimulatorBehaviorCapability(value)).toEqual({
        valid: false,
        errors: [`simulator_behavior must be one of ${SIMULATOR_BEHAVIORS.join(', ')}`],
      });
    });
  });

  describe('ProviderRegistryService.replaceCapabilities', () => {
    const principal = {} as AuthPrincipal;
    const providerId = '01955b0a-7b3b-7411-9a4f-9e67d4f9a001';

    /** A service whose transaction is never opened unless the set is valid. */
    function makeService() {
      const withRequestTenant = jest.fn(async () => 'saved');
      const invalidateLocal = jest.fn();
      const service = new ProviderRegistryService(
        { withRequestTenant } as unknown as TenantDatabase,
        {} as ProviderAccess,
        {} as ListQuery,
        {} as ProviderSubmissionExecutor,
        {} as ProviderStateStore,
        { invalidateLocal } as unknown as ProviderConfigurationCache,
      );
      return { service, withRequestTenant };
    }

    async function refusal(capabilities: { key: string; value: unknown }[]) {
      const { service, withRequestTenant } = makeService();
      const error = await service.replaceCapabilities(principal, providerId, { capabilities }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(withRequestTenant).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(AppException);
      return error as AppException;
    }

    it.each(SIMULATOR_BEHAVIORS.map((b) => [b]))('saves %s', async (value) => {
      const { service, withRequestTenant } = makeService();
      await expect(
        service.replaceCapabilities(principal, providerId, {
          capabilities: [{ key: 'simulator_behavior', value }],
        }),
      ).resolves.toBe('saved');
      expect(withRequestTenant).toHaveBeenCalledTimes(1);
    });

    it.each(INVALID_VALUES)(
      'refuses %s with a field-level INVALID_VALUE and opens no transaction',
      async (_label, value) => {
        const error = await refusal([
          { key: 'max_segments', value: 10 },
          { key: 'simulator_behavior', value },
        ]);
        expect(error.getStatus()).toBe(400);
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.details).toEqual({
          issues: [
            {
              field: 'capabilities.1',
              rule: 'INVALID_VALUE',
              message: `simulator_behavior must be one of ${SIMULATOR_BEHAVIORS.join(', ')}`,
            },
          ],
        });
      },
    );

    it('keeps the rcs_message_types rule unchanged', async () => {
      const error = await refusal([{ key: 'rcs_message_types', value: [] }]);
      expect(error.details).toEqual({
        issues: [
          {
            field: 'capabilities.0',
            rule: 'INVALID_VALUE',
            message: 'rcs_message_types must be a non-empty array',
          },
        ],
      });
    });

    it('leaves other keys free-form, including values simulator_behavior refuses', async () => {
      const { service, withRequestTenant } = makeService();
      await expect(
        service.replaceCapabilities(principal, providerId, {
          capabilities: [
            { key: 'constructor', value: '' },
            { key: 'media_support', value: true },
            { key: 'rcs_brand_label', value: { anything: [1, 'two'] } },
            { key: 'simulator_note', value: 'FAIL' },
            { key: 'tostring', value: null },
          ],
        }),
      ).resolves.toBe('saved');
      expect(withRequestTenant).toHaveBeenCalledTimes(1);
    });

    it('still reports the other rules alongside it', async () => {
      const error = await refusal([
        { key: 'simulator_behavior', value: '' },
        { key: 'simulator_behavior', value: 'SUCCESS' },
      ]);
      expect(error.details).toEqual({
        issues: [
          expect.objectContaining({ field: 'capabilities.0', rule: 'INVALID_VALUE' }),
          expect.objectContaining({ field: 'capabilities.1', rule: 'DUPLICATE_KEY' }),
        ],
      });
    });
  });
});
