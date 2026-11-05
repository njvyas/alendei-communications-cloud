/**
 * Test fixture: a temporary copy of the committed migrations folder with ONE extra,
 * test-only migration after the newest committed one. It lets a suite prove that
 * nothing after a recorded barrier is applied when that barrier no longer holds,
 * without adding a real migration to the repository. The copy lives in the OS temp
 * directory and is removed by `cleanup()`; the repository's folder is never written.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const REPO_MIGRATIONS = resolve(__dirname, '../../migrations');
export const FOLLOWING_TAG = '9999_u141a_test_only_following_migration';
/** The object the test-only migration creates; its presence means it was applied. */
export const FOLLOWING_PROBE = 'public.u141a_test_only_probe';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export function migrationsWithFollowing(): { folder: string; cleanup: () => void } {
  const folder = mkdtempSync(join(tmpdir(), 'acc-u141a-migrations-'));
  cpSync(REPO_MIGRATIONS, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] };
  const last = journal.entries[journal.entries.length - 1]!;
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 86_400_000,
    tag: FOLLOWING_TAG,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(
    join(folder, `${FOLLOWING_TAG}.sql`),
    `CREATE TABLE ${FOLLOWING_PROBE} (id integer);\n`,
  );
  return { folder, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}
