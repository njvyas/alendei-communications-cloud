import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  MigrationHistoryError,
  loadExpectedMigrations,
  verifyMigrationHistory,
  type AppliedMigration,
  type ExpectedMigration,
} from './migration-history';

const REPO_MIGRATIONS = resolve(__dirname, '../../migrations');

const applyAll = (
  expected: readonly ExpectedMigration[],
  upTo = expected.length,
): AppliedMigration[] =>
  expected.slice(0, upTo).map((m, i) => ({ id: i + 1, hash: m.hash, createdAt: m.when }));

describe('loadExpectedMigrations — the committed journal', () => {
  const expected = loadExpectedMigrations(REPO_MIGRATIONS);

  it('reads every journal entry, in order, with drizzle-identical file hashes', () => {
    const journal = JSON.parse(
      readFileSync(join(REPO_MIGRATIONS, 'meta/_journal.json'), 'utf8'),
    ) as {
      entries: Array<{ tag: string; when: number }>;
    };
    expect(expected.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    for (const m of expected) {
      const sha = createHash('sha256')
        .update(readFileSync(join(REPO_MIGRATIONS, `${m.tag}.sql`)).toString())
        .digest('hex');
      expect(m.hash).toBe(sha);
    }
  });

  it('has strictly increasing "when" values (existing ordering is valid)', () => {
    for (let i = 1; i < expected.length; i++)
      expect(expected[i]!.when).toBeGreaterThan(expected[i - 1]!.when);
  });

  it('accepts a clean database (no history): everything is pending', () => {
    const verdict = verifyMigrationHistory(expected, []);
    expect(verdict.problems).toEqual([]);
    expect(verdict.pending).toHaveLength(expected.length);
  });

  it('accepts a correct partial history and reports only the remainder as pending', () => {
    const verdict = verifyMigrationHistory(expected, applyAll(expected, 25));
    expect(verdict.problems).toEqual([]);
    expect(verdict.pending.map((m) => m.idx)).toEqual(expected.slice(25).map((m) => m.idx));
  });

  it('accepts a complete history: nothing pending', () => {
    const verdict = verifyMigrationHistory(expected, applyAll(expected));
    expect(verdict).toEqual({ problems: [], applied: expected.length, pending: [] });
  });

  it('accepts id gaps (a sequence gap is not a history defect)', () => {
    const applied = applyAll(expected).map((r, i) => ({ ...r, id: i < 15 ? r.id : r.id + 1 }));
    expect(verifyMigrationHistory(expected, applied).problems).toEqual([]);
  });

  it('refuses the observed defect: 0033 recorded with a hash that is not the committed file', () => {
    const applied = applyAll(expected).map((r) =>
      r.createdAt === expected[33]!.when
        ? { ...r, hash: '914e700ae8bb8f9f3eca4c811e2320bd1e3caca86db17fe4e956ebc355a569c6' }
        : r,
    );
    const verdict = verifyMigrationHistory(expected, applied);
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain('0033_phase3_3_orchestrator_dispatch');
    expect(verdict.problems[0]).toContain('does not match the file');
  });

  it('refuses a history row whose created_at matches no journal entry (orphan)', () => {
    const applied = [
      ...applyAll(expected, 3),
      { id: 4, hash: 'x'.repeat(64), createdAt: expected[2]!.when + 1 },
    ];
    const verdict = verifyMigrationHistory(expected, applied);
    expect(verdict.problems.join('\n')).toContain('matches no journal entry');
  });

  it('refuses out-of-order history', () => {
    const applied = applyAll(expected, 4);
    const swapped = [applied[0]!, applied[2]!, applied[1]!, applied[3]!].map((r, i) => ({
      ...r,
      id: i + 1,
    }));
    const problems = verifyMigrationHistory(expected, swapped).problems.join('\n');
    expect(problems).toContain('out of order');
    expect(problems).toContain('expected journal position');
  });

  it('refuses a skipped migration (history is not a journal prefix)', () => {
    const applied = applyAll(expected, 5)
      .filter((_, i) => i !== 2)
      .map((r, i) => ({ ...r, id: i + 1 }));
    expect(verifyMigrationHistory(expected, applied).problems.join('\n')).toContain(
      'expected journal position',
    );
  });

  it('refuses a database that records more migrations than the journal has', () => {
    const shortJournal = expected.slice(0, 10);
    expect(
      verifyMigrationHistory(shortJournal, applyAll(expected, 11)).problems.join('\n'),
    ).toContain('matches no journal entry');
  });

  it('refuses non-increasing history ids', () => {
    const applied = applyAll(expected, 3).map((r) => ({ ...r, id: 7 }));
    expect(verifyMigrationHistory(expected, applied).problems.join('\n')).toContain(
      'is not after id',
    );
  });
});

describe('loadExpectedMigrations — a defective journal fails closed', () => {
  let dir: string;
  const write = (entries: unknown[], files: Record<string, string>) => {
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ entries }));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  };
  const problemsOf = (): string => {
    try {
      loadExpectedMigrations(dir);
      return '';
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationHistoryError);
      return (error as MigrationHistoryError).problems.join('\n');
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'acc-migration-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts a well-formed journal', () => {
    write(
      [
        { idx: 0, tag: '0000_a', when: 100 },
        { idx: 1, tag: '0001_b', when: 200 },
      ],
      { '0000_a.sql': 'select 1;', '0001_b.sql': 'select 2;' },
    );
    expect(problemsOf()).toBe('');
  });

  it.each([
    [
      'a non-increasing "when"',
      [
        { idx: 0, tag: '0000_a', when: 200 },
        { idx: 1, tag: '0001_b', when: 200 },
      ],
      { '0000_a.sql': '', '0001_b.sql': '' },
      'is not after',
    ],
    [
      'a duplicate tag',
      [
        { idx: 0, tag: '0000_a', when: 100 },
        { idx: 1, tag: '0000_a', when: 200 },
      ],
      { '0000_a.sql': '' },
      'duplicate tag',
    ],
    ['a missing migration file', [{ idx: 0, tag: '0000_a', when: 100 }], {}, 'is missing'],
    [
      'a migration file outside the journal',
      [{ idx: 0, tag: '0000_a', when: 100 }],
      { '0000_a.sql': '', '0001_rogue.sql': '' },
      'has no journal entry',
    ],
    ['a wrong idx', [{ idx: 3, tag: '0000_a', when: 100 }], { '0000_a.sql': '' }, 'idx is 3'],
    [
      'a non-integer "when"',
      [{ idx: 0, tag: '0000_a', when: 'x' }],
      { '0000_a.sql': '' },
      'positive integer',
    ],
    ['an empty journal', [], {}, 'no entries'],
  ])('refuses %s', (_label, entries, files, message) => {
    write(entries, files);
    expect(problemsOf()).toContain(message);
  });

  it('detects an applied migration edited after it was applied', () => {
    write([{ idx: 0, tag: '0000_a', when: 100 }], { '0000_a.sql': 'select 1;' });
    const before = loadExpectedMigrations(dir);
    writeFileSync(join(dir, '0000_a.sql'), 'select 1; -- edited');
    const after = loadExpectedMigrations(dir);
    const verdict = verifyMigrationHistory(after, applyAll(before));
    expect(verdict.problems.join('\n')).toContain('does not match the file');
  });
});

describe('migration files keep their committed bytes on every checkout', () => {
  const repo = resolve(REPO_MIGRATIONS, '../../..');
  const git = (args: string[], input?: string) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8', input });
  const tracked = git(['ls-files', 'packages/db/migrations']).stdout.split('\n').filter(Boolean);

  it('tracks the migration files', () => {
    expect(tracked.filter((f) => f.endsWith('.sql'))).toHaveLength(
      loadExpectedMigrations(REPO_MIGRATIONS).length,
    );
  });

  it('disables line-ending conversion for every migration file and journal (.gitattributes -text)', () => {
    const attrs = git(['check-attr', 'text', '--stdin'], `${tracked.join('\n')}\n`).stdout;
    const notUnset = attrs
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.endsWith(': text: unset'));
    expect(notUnset).toEqual([]);
  });

  it('contains no carriage return in any migration file (hashes are of LF bytes)', () => {
    const withCr = tracked.filter((f) => readFileSync(join(repo, f)).includes(0x0d));
    expect(withCr).toEqual([]);
  });
});
