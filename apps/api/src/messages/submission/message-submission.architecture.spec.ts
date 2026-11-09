/**
 * Phase 7 PR 7-3: structural guarantees of the shared message submission core
 * (handover `docs/PHASE-7-3-SEND-PATH-HANDOVER.md` §11.3).
 *
 *   1. One creation path: only the core creates a message or its first queue row.
 *   2. Isolation: the core opens no transaction, reads no request context, and
 *      reaches no pricing, ledger, provider, dispatcher or campaign code. Its one
 *      billing reference (Phase 7 PR 7-4) is `MessageReservationService`, the only
 *      application caller of `app_message_reserve`; it posts no settlement fact.
 *   3. Order: the checks run in the pre-7-3 order, then the inserts, then (7-4)
 *      the funds reservation as the last step.
 *   4. Authorization proof: the core refuses, before touching the transaction, a
 *      forged proof or one bound to another transaction or organization; minting
 *      is exactly the pre-7-3 `messages.send` check.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PERMISSIONS, type AuthPrincipal } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import type { AuthorizationService } from '../../auth/authorization.service';
import type { MessageReservationService } from '../../billing/message-reservation.service';
import type { AppConfigService } from '../../config/app-config.service';
import { MessageSubmissionCore } from './message-submission.core';
import { authorizeSubmission, type SubmissionAuthorization } from './submission-authorization';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SRC = join(ROOT, 'apps/api/src');
const CORE = 'apps/api/src/messages/submission/message-submission.core.ts';

/** Source without comments, so prose cannot satisfy or defeat a check. */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !/\.spec\.ts$/.test(path) ? [path] : [];
  });

const filesMatching = (pattern: RegExp): string[] =>
  sources(SRC)
    .filter((path) => pattern.test(code(path)))
    .map((path) => relative(ROOT, path))
    .sort();

describe('Phase 7-3: the shared message submission core', () => {
  it('finds the files it asserts over', () => {
    expect(sources(SRC).length).toBeGreaterThan(100);
    expect(code(join(ROOT, CORE)).length).toBeGreaterThan(5000);
  });

  describe('1. one creation path', () => {
    it('only the core inserts into messages', () => {
      expect(filesMatching(/insert\(\s*schema\.messages\s*\)|insert\s+into\s+messages\b/i)).toEqual(
        [CORE],
      );
    });

    it('only the core inserts into message_dispatch_queue', () => {
      expect(
        filesMatching(
          /insert\(\s*schema\.messageDispatchQueue\s*\)|insert\s+into\s+message_dispatch_queue\b/i,
        ),
      ).toEqual([CORE]);
    });

    it('message.queued is written by the core and, on a fallback requeue, by the dispatcher only', () => {
      expect(filesMatching(/['"`]message\.queued['"`]/)).toEqual([
        'apps/api/src/messages/dispatch/dispatcher.service.ts',
        CORE,
      ]);
    });
  });

  describe('1b. one reservation path (Phase 7 PR 7-4)', () => {
    it('only MessageReservationService names app_message_reserve', () => {
      expect(filesMatching(/app_message_reserve/)).toEqual([
        'apps/api/src/billing/message-reservation.service.ts',
      ]);
    });

    it('no application code names the 7.1 writer or the 7.2 rating functions', () => {
      expect(filesMatching(/app_ledger_post|app_rate_message|app_price_lookup/)).toEqual([]);
    });

    it('only the core reserves; the dispatcher does not reach the reservation service', () => {
      expect(filesMatching(/MessageReservationService|\.reserve\(tx,/)).toEqual([
        'apps/api/src/billing/billing.module.ts',
        'apps/api/src/billing/message-reservation.service.ts',
        CORE,
      ]);
    });

    it('no application code posts a settlement fact', () => {
      expect(filesMatching(/'(customer_charge|reservation_release|provider_cost)'/)).toEqual([]);
    });
  });

  describe('2. isolation', () => {
    const core = code(join(ROOT, CORE));

    it.each([
      'RequestContext',
      'withTenant',
      'withRequestTenant',
      'whenReleased',
      'withAuth',
      'IdempotencyService',
      'TenantDatabase',
      'AuthorizationService',
      'COMMIT',
    ])('does not reference %s', (name) => {
      expect(core).not.toContain(name);
    });

    it('opens no transaction other than the contact savepoint', () => {
      expect(core.match(/\.transaction\(/g)).toHaveLength(1);
      expect(core).toMatch(/tx\.transaction\(async \(savepoint\)/);
    });

    it.each([
      /app_rate_message|app_price_lookup|app_ledger_post|app_ledger_|app_message_reserve/,
      /usage_ledger|usageLedger|wallets|credit_accounts|creditAccounts|pricing/i,
      /customer_charge|reservation_release|provider_cost|settle/i,
      /provider-adapters|ProviderAdapter|dispatch\/|DispatcherService|campaign/i,
    ])('references nothing matching %s', (pattern) => {
      expect(core).not.toMatch(pattern);
    });

    it('its only billing dependency is MessageReservationService, called once, last (7-4)', () => {
      expect([...core.matchAll(/from '([^']*billing[^']*)'/g)].map((m) => m[1])).toEqual([
        '../../billing/message-reservation.service',
      ]);
      expect(core.match(/this\.reservation\./g)).toHaveLength(1);
      expect(core).toMatch(/if \(billing\) await this\.reservation\.reserve\(tx, messageId\);/);
    });

    it('imports only contracts, db, drizzle, uuidv7, the reservation service and its own config, error and normalisation helpers', () => {
      const imports = [...core.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
      expect(imports).toEqual([
        '../../billing/message-reservation.service',
        '../../common/errors/app.exception',
        '../../config/app-config.service',
        '../../contacts/contacts.normalization',
        './submission-authorization',
        './submission.types',
        '@acc/contracts',
        '@acc/db',
        '@nestjs/common',
        'drizzle-orm',
        'uuidv7',
      ]);
    });

    it('is not exported from MessagesModule (no second consumer in 7-3)', () => {
      const module = code(join(SRC, 'messages/messages.module.ts'));
      expect(module).toMatch(/providers:[^\]]*MessageSubmissionCore/);
      expect(module).not.toMatch(/exports:[^\]]*MessageSubmissionCore/);
    });
  });

  describe('3. order', () => {
    it('runs the checks in the pre-7-3 order, then the inserts, then the reservation', () => {
      const raw = readFileSync(join(ROOT, CORE), 'utf8');
      const markers = [
        'assertSubmissionAuthorized(',
        '// 1. Channel preflight',
        '// Determine workspace',
        '// 2. Address normalization',
        '// 3. Suppression preflight check',
        '// 4. Resolve or create contact and identity',
        '// 5. Consent preflight check',
        '// 6. Template preflight check',
        '// 6b. Channel-specific regulatory & payload validation',
        '// 7. Active Provider Assignment preflight check',
        '// 7b. Billing snapshot (enforcement only)',
        '// 8. Insert into messages',
        '// 9. Enqueue into message_dispatch_queue',
        '// 10. Record event in message_events',
        '// 11. Reserve funds (enforcement only)',
      ];
      const positions = markers.map((m) => raw.indexOf(m));
      for (const [i, p] of positions.entries())
        expect([markers[i], p >= 0]).toEqual([markers[i], true]);
      expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    });
  });

  describe('4. authorization proof', () => {
    const principal = { userId: 'u' } as unknown as AuthPrincipal;
    const request = { channelCode: 'whatsapp', recipient: '+12025550100', payload: {} };

    /** A transaction that records every property touched. */
    const recordingTx = () => {
      const touched: PropertyKey[] = [];
      const tx = new Proxy(
        {},
        {
          get: (_t, prop) => {
            touched.push(prop);
            return () => {
              throw new Error('the transaction must not be used');
            };
          },
        },
      ) as unknown as Transaction;
      return { tx, touched };
    };

    const authorization = () => {
      const assert = jest.fn().mockResolvedValue(undefined);
      return { service: { assert } as unknown as AuthorizationService, assert };
    };

    const reserve = jest.fn();
    const core = new MessageSubmissionCore(
      { sms: {}, billing: { enforcementEnabled: true } } as unknown as AppConfigService,
      { reserve } as unknown as MessageReservationService,
    );
    afterEach(() => expect(reserve).not.toHaveBeenCalled());

    it('minting asserts exactly messages.send at organization scope', async () => {
      const { service, assert } = authorization();
      const tx = {} as Transaction;
      await authorizeSubmission(service, tx, principal, 'org-1');
      expect(assert).toHaveBeenCalledTimes(1);
      expect(assert).toHaveBeenCalledWith(tx, {
        principal,
        permission: PERMISSIONS.MESSAGES_SEND,
        target: { scopeType: 'organization', scopeId: 'org-1' },
        resourceType: 'Organization',
      });
    });

    it('a refused check mints nothing', async () => {
      const assert = jest.fn().mockRejectedValue(new Error('denied'));
      await expect(
        authorizeSubmission(
          { assert } as unknown as AuthorizationService,
          {} as Transaction,
          principal,
          'org-1',
        ),
      ).rejects.toThrow('denied');
    });

    it('refuses a forged proof before touching the transaction', async () => {
      const { tx, touched } = recordingTx();
      const forged = Object.freeze({}) as SubmissionAuthorization;
      await expect(
        core.submit(tx, { orgId: 'org-1', correlationId: 'c', authorization: forged }, request),
      ).rejects.toThrow(/no messages\.send authorization/);
      expect(touched).toEqual([]);
    });

    it('refuses a proof minted on another transaction', async () => {
      const { service } = authorization();
      const proof = await authorizeSubmission(service, {} as Transaction, principal, 'org-1');
      const { tx, touched } = recordingTx();
      await expect(
        core.submit(tx, { orgId: 'org-1', correlationId: 'c', authorization: proof }, request),
      ).rejects.toThrow(/no messages\.send authorization/);
      expect(touched).toEqual([]);
    });

    it('refuses a proof minted for another organization', async () => {
      const { service } = authorization();
      const { tx, touched } = recordingTx();
      const proof = await authorizeSubmission(service, tx, principal, 'org-1');
      await expect(
        core.submit(tx, { orgId: 'org-2', correlationId: 'c', authorization: proof }, request),
      ).rejects.toThrow(/no messages\.send authorization/);
      expect(touched).toEqual([]);
    });

    it('refuses a missing proof', async () => {
      const { tx, touched } = recordingTx();
      await expect(
        core.submit(
          tx,
          {
            orgId: 'org-1',
            correlationId: 'c',
            authorization: undefined as unknown as SubmissionAuthorization,
          },
          request,
        ),
      ).rejects.toThrow(/no messages\.send authorization/);
      expect(touched).toEqual([]);
    });
  });
});
