/**
 * Phase 8C PR 8C-5b: the send port's production binding, the refusal mapping (handover Rev 2
 * §7.3), the outcome semantics (§7.4) and the re-check schedule (§6) — and the structural
 * guarantees that no journey code can create a message.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ERROR_CODES, journeySendRefusedCode } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import {
  UnavailableJourneySendPort,
  messageOutcomeReached,
  nextOutcomeRecheck,
  sendRefusalDisposition,
  type JourneySendInput,
} from './journey-send.port';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SRC = join(ROOT, 'apps/api/src');
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
const rel = (path: string) => relative(ROOT, path);

describe('Phase 8C-5b: journey send port', () => {
  it('the production port is always unavailable and touches nothing', async () => {
    const tx = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the transaction must not be used');
        },
      },
    ) as unknown as Transaction;
    await expect(
      new UnavailableJourneySendPort().send(tx, {} as JourneySendInput),
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  describe('refusal mapping (§7.3)', () => {
    it.each([
      [ERROR_CODES.RECIPIENT_SUPPRESSED, 'skip'],
      [ERROR_CODES.CONSENT_REVOKED, 'skip'],
      [ERROR_CODES.BILLING_INSUFFICIENT_FUNDS, 'refuse'],
      [ERROR_CODES.BILLING_ACCOUNT_FROZEN, 'refuse'],
      [ERROR_CODES.BILLING_ACCOUNT_NOT_CONFIGURED, 'refuse'],
      [ERROR_CODES.BILLING_PRICE_NOT_CONFIGURED, 'refuse'],
      [ERROR_CODES.NO_ACTIVE_PROVIDER_ASSIGNMENT, 'refuse'],
      [ERROR_CODES.BILLING_BUSY, 'transient'],
      ['40001', 'transient'],
      ['40P01', 'transient'],
      ['55P03', 'transient'],
      [ERROR_CODES.TEMPLATE_NOT_APPROVED, 'fail'],
      [ERROR_CODES.VALIDATION_FAILED, 'fail'],
      [ERROR_CODES.RESOURCE_NOT_FOUND, 'fail'],
      [ERROR_CODES.CHANNEL_NOT_SUPPORTED, 'fail'],
      [ERROR_CODES.SMS_PAYLOAD_INVALID, 'fail'],
      [ERROR_CODES.SMS_DLT_TEMPLATE_MISMATCH, 'fail'],
      ['SOMETHING_ELSE', 'poison'],
      ['23505', 'poison'],
    ])('%s → %s', (code, disposition) => {
      expect(sendRefusalDisposition(code)).toBe(disposition);
    });

    it('records refusals as SEND_REFUSED_<code>, bounded to the column', () => {
      expect(journeySendRefusedCode('CONSENT_REVOKED')).toBe('SEND_REFUSED_CONSENT_REVOKED');
      expect(journeySendRefusedCode('X'.repeat(200))).toHaveLength(100);
    });
  });

  describe('outcome semantics (§7.4)', () => {
    const m = (status: string, deliveryStatus: string | null, read = false) => ({
      status,
      deliveryStatus,
      readAt: read ? new Date() : null,
    });
    it.each([
      [m('accepted', 'delivered'), 'delivered', true],
      [m('accepted', 'pending'), 'delivered', false],
      [m('accepted', 'not_supported'), 'delivered', false],
      [m('accepted', null), 'delivered', false],
      [m('outcome_unknown', null), 'delivered', false],
      [m('accepted', 'delivered', true), 'read', true],
      [m('accepted', 'delivered'), 'read', false],
      [m('failed', null), 'failed', true],
      [m('accepted', 'undelivered'), 'failed', true],
      [m('outcome_unknown', null), 'failed', false],
      [m('accepted', 'pending'), 'failed', false],
    ] as const)('%j reaches %s: %s', (message, outcome, reached) => {
      expect(messageOutcomeReached(message, outcome)).toBe(reached);
    });
  });

  describe('re-check schedule (§6)', () => {
    const t0 = new Date('2026-11-14T00:00:00Z');
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    it('every 5 minutes during the first hour, then hourly, never past the deadline', () => {
      const deadline = at(86_400);
      expect(nextOutcomeRecheck(t0, deadline, t0)).toEqual(at(300));
      expect(nextOutcomeRecheck(t0, deadline, at(3_000))).toEqual(at(3_300));
      expect(nextOutcomeRecheck(t0, deadline, at(3_600))).toEqual(at(7_200));
      expect(nextOutcomeRecheck(t0, deadline, at(86_000))).toEqual(deadline);
      expect(nextOutcomeRecheck(t0, at(120), t0)).toEqual(at(120));
    });

    it('a 366-day wait re-arms about 8,800 times, with no history rows', () => {
      const deadline = at(366 * 86_400);
      let now = t0;
      let rearms = 0;
      while (now < deadline) {
        now = nextOutcomeRecheck(t0, deadline, now);
        rearms++;
      }
      expect(rearms).toBeGreaterThan(8_700);
      expect(rearms).toBeLessThan(8_900);
    });
  });

  describe('structure: no journey code path can create a message', () => {
    const journeys = sources(join(SRC, 'journeys'));

    it('finds the journey sources', () => {
      expect(journeys.length).toBeGreaterThan(15);
    });

    it('the module binds the port to UnavailableJourneySendPort, and nothing else implements it', () => {
      const module = code(join(SRC, 'journeys/journeys.module.ts'));
      expect(module).toMatch(
        /\{\s*provide:\s*JOURNEY_SEND_PORT,\s*useClass:\s*UnavailableJourneySendPort\s*\}/,
      );
      expect(module.match(/JOURNEY_SEND_PORT/g)).toHaveLength(2); // import + the one binding
      expect(
        sources(SRC)
          .filter((p) => /implements\s+JourneySendPort\b/.test(code(p)))
          .map(rel),
      ).toEqual(['apps/api/src/journeys/runner/journey-send.port.ts']);
    });

    it('no journeys code reaches the submission core, names a SubmissionOrigin or writes a message table', () => {
      const offending = journeys
        .filter((p) =>
          /MessageSubmissionCore|messages\/submission|authorizeSubmission|SubmissionOrigin|insert\(\s*schema\.(messages|messageDispatchQueue|messageEvents)\s*\)|update\(\s*schema\.messages\s*\)|insert\s+into\s+(messages|message_dispatch_queue|message_events)\b|update\s+messages\b/i.test(
            code(p),
          ),
        )
        .map(rel);
      expect(offending).toEqual([]);
    });

    it('the runner reads messages only through the evaluator, by the granted outcome columns', () => {
      const readers = journeys.filter((p) => /schema\.messages\b/.test(code(p))).map(rel);
      expect(readers).toEqual(['apps/api/src/journeys/runner/journey-node-evaluator.ts']);
      const evaluator = code(join(SRC, 'journeys/runner/journey-node-evaluator.ts'));
      expect(evaluator.match(/schema\.messages\b/g)).toHaveLength(1); // const msg = schema.messages
      const columns = [...evaluator.matchAll(/\bmsg\.(\w+)/g)].map((m) => m[1]);
      expect(new Set(columns)).toEqual(
        new Set(['status', 'deliveryStatus', 'readAt', 'id', 'orgId']),
      );
    });

    it('a send runs the port inside its own savepoint', () => {
      const evaluator = code(join(SRC, 'journeys/runner/journey-node-evaluator.ts'));
      expect(evaluator).toMatch(
        /tx\.transaction\(async \(savepoint\) => \{\s*const r = await port\.send\(savepoint,/,
      );
    });
  });
});
