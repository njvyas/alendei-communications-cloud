/**
 * Phase 7 PR 7-5: structural guarantees of dispatcher settlement
 * (`DECISIONS.md` §1zi.8).
 *
 *   1. Only the dispatcher reaches the settlement functions, and no application
 *      code names the 7.1 writer or the 7.2 rating functions.
 *   2. Every site that deletes the queue row (the end of a message's dispatch)
 *      settles first, while the claim is still live.
 *   3. Settlement is gated on the message's own billing_enforced, never the flag.
 *   4. Receipts are evidence only: delivery code reaches no billing function.
 *   5. Both dispatch fences are read under the queue-row lock.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SRC = join(ROOT, 'apps/api/src');
const DISPATCHER = 'apps/api/src/messages/dispatch/dispatcher.service.ts';

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

describe('Phase 7-5: dispatcher settlement', () => {
  const dispatcher = code(join(ROOT, DISPATCHER));

  it('only the dispatcher names the settlement functions', () => {
    expect(
      filesMatching(/app_dispatch_(attempt_reserve|attempt_settle|message_settle|billing_claim)/),
    ).toEqual([DISPATCHER]);
  });

  it('no application code names the 7.1 writer or the 7.2 rating functions', () => {
    expect(filesMatching(/app_ledger_post|app_rate_message|app_price_lookup/)).toEqual([]);
  });

  it('every queue-row delete is preceded by the message settlement, in the same block', () => {
    const lines = dispatcher.split('\n');
    const deletes = lines
      .map((line, i) => [line, i] as const)
      .filter(([line]) => /DELETE FROM message_dispatch_queue/.test(line));
    expect(deletes.length).toBeGreaterThanOrEqual(12);
    for (const [, i] of deletes) {
      const before = lines.slice(Math.max(0, i - 3), i).join('\n');
      expect([i + 1, /this\.settleMessageBilling\(client, enforced\)/.test(before)]).toEqual([
        i + 1,
        true,
      ]);
    }
  });

  it('settlement is gated on the message’s billing_enforced, never on configuration', () => {
    expect(dispatcher).not.toMatch(/AppConfigService|enforcementEnabled|BILLING_ENFORCEMENT/);
    expect(dispatcher).toMatch(/SELECT status, current_attempt_id, billing_enforced FROM messages/);
    expect(dispatcher).toMatch(/SELECT billing_enforced FROM messages WHERE id = \$1/);
    for (const helper of ['settleMessageBilling', 'settleAttemptBilling']) {
      expect(dispatcher).toMatch(
        new RegExp(
          `private async ${helper}\\([^)]*enforced: boolean[\\s\\S]*?if \\(!enforced\\) return;`,
        ),
      );
    }
  });

  it('receipts are evidence only: delivery and webhook code reach no billing function', () => {
    const delivery = sources(SRC).filter((path) =>
      /\/(messages\/delivery|webhooks)\//.test(relative(ROOT, path)),
    );
    expect(delivery.length).toBeGreaterThan(2);
    for (const path of delivery) {
      expect([
        relative(ROOT, path),
        /app_dispatch_|app_ledger|usage_ledger|reservation/.test(code(path)),
      ]).toEqual([relative(ROOT, path), false]);
    }
  });

  it('both dispatch fences are read FOR UPDATE', () => {
    expect(dispatcher).toMatch(
      /SELECT claim_token, dispatch_epoch FROM message_dispatch_queue WHERE message_id = \$1 FOR UPDATE/,
    );
    expect(dispatcher).toMatch(
      /SELECT dispatch_epoch, claim_token\s+FROM message_dispatch_queue\s+WHERE message_id = \$1\s+FOR UPDATE/,
    );
  });

  it('lease recovery takes one expired lease per transaction', () => {
    const recovery = dispatcher.slice(dispatcher.indexOf('async recoverExpiredLeases'));
    expect(recovery).toMatch(/LIMIT 1\s+FOR UPDATE SKIP LOCKED/);
    expect(recovery.slice(0, recovery.indexOf('async dispatchBatch'))).not.toMatch(
      /for \(const row of/,
    );
  });
});
