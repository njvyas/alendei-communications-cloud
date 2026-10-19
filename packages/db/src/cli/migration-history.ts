/**
 * Fail-closed verification of `drizzle.__drizzle_migrations` against the
 * committed journal and migration files, run before any migration is applied.
 *
 * Why it exists: drizzle-orm's migrator (0.45.x) reads only the newest history
 * row and applies every journal entry whose `when` is later. It never compares
 * the hashes of migrations already applied, so an applied migration that was
 * later edited — or a history row rewritten by hand — passes silently. This
 * module refuses all of that before drizzle runs.
 *
 * Model (drizzle semantics): the applied history must be exactly a prefix of
 * the journal — row i is journal entry i, with the same `when` (`created_at`)
 * and the same SHA-256 of the file. Pending migrations are the remainder.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ExpectedMigration {
  readonly idx: number;
  readonly tag: string;
  /** Journal `when`; drizzle stores it as `created_at`. */
  readonly when: number;
  /** SHA-256 of the migration file, exactly as drizzle records it. */
  readonly hash: string;
}

export interface AppliedMigration {
  readonly id: number;
  readonly hash: string;
  readonly createdAt: number;
}

export interface HistoryVerdict {
  readonly problems: readonly string[];
  readonly applied: number;
  readonly pending: readonly ExpectedMigration[];
}

export class MigrationHistoryError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `Refusing to migrate: migration history does not match the committed journal and files.\n` +
        problems.map((p) => `  - ${p}`).join('\n'),
    );
    this.name = 'MigrationHistoryError';
  }
}

interface JournalFile {
  readonly entries?: ReadonlyArray<{ idx?: unknown; tag?: unknown; when?: unknown }>;
}

/**
 * Reads the journal and every migration file, and validates the journal itself:
 * contiguous `idx`, unique tags, strictly increasing integer `when`, a file for
 * every entry and no migration file outside the journal. Hashes are computed
 * the way drizzle's `readMigrationFiles` computes them (SHA-256 of the file's
 * text), so they compare equal to what drizzle stores.
 */
export function loadExpectedMigrations(migrationsFolder: string): ExpectedMigration[] {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  if (!existsSync(journalPath)) throw new MigrationHistoryError([`missing ${journalPath}`]);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  const entries = journal.entries ?? [];
  const problems: string[] = [];
  const expected: ExpectedMigration[] = [];
  const tags = new Set<string>();

  entries.forEach((entry, position) => {
    const { idx, tag, when } = entry;
    if (idx !== position) problems.push(`journal entry ${position}: idx is ${String(idx)}`);
    if (typeof tag !== 'string' || tag.length === 0) {
      problems.push(`journal entry ${position}: missing tag`);
      return;
    }
    if (tags.has(tag)) problems.push(`journal entry ${position}: duplicate tag ${tag}`);
    tags.add(tag);
    if (typeof when !== 'number' || !Number.isSafeInteger(when) || when <= 0) {
      problems.push(`journal entry ${tag}: "when" is not a positive integer`);
      return;
    }
    const previous = expected[expected.length - 1];
    if (previous && when <= previous.when) {
      problems.push(
        `journal entry ${tag}: "when" ${when} is not after ${previous.tag} (${previous.when})`,
      );
    }
    const file = join(migrationsFolder, `${tag}.sql`);
    if (!existsSync(file)) {
      problems.push(`journal entry ${tag}: file ${tag}.sql is missing`);
      return;
    }
    const hash = createHash('sha256').update(readFileSync(file).toString()).digest('hex');
    expected.push({ idx: position, tag, when, hash });
  });

  if (entries.length === 0) problems.push('journal has no entries');
  for (const file of readdirSync(migrationsFolder)) {
    if (file.endsWith('.sql') && !tags.has(file.slice(0, -'.sql'.length))) {
      problems.push(`migration file ${file} has no journal entry`);
    }
  }

  if (problems.length > 0) throw new MigrationHistoryError(problems);
  return expected;
}

/**
 * Compares the applied history with the expected journal. Pure: no I/O.
 * Every discrepancy is reported; any discrepancy means "do not migrate".
 */
export function verifyMigrationHistory(
  expected: readonly ExpectedMigration[],
  applied: readonly AppliedMigration[],
): HistoryVerdict {
  const problems: string[] = [];
  const byWhen = new Map(expected.map((m) => [m.when, m]));

  applied.forEach((row, i) => {
    const previous = applied[i - 1];
    if (previous && row.id <= previous.id) {
      problems.push(`history row id ${row.id} is not after id ${previous.id}`);
    }
    if (previous && row.createdAt <= previous.createdAt) {
      problems.push(
        `history row id ${row.id}: created_at ${row.createdAt} is not after ${previous.createdAt} (out of order)`,
      );
    }
    const slot = expected[i];
    const match = byWhen.get(row.createdAt);
    if (!match) {
      problems.push(
        `history row id ${row.id}: created_at ${row.createdAt} matches no journal entry`,
      );
      return;
    }
    if (!slot || match.idx !== slot.idx) {
      problems.push(
        `history row id ${row.id} (${match.tag}) is at history position ${i}, expected journal position ${match.idx}`,
      );
    }
    if (row.hash !== match.hash) {
      problems.push(
        `history row id ${row.id} (${match.tag}): recorded hash ${row.hash.slice(0, 16)}… does not match the file ${match.hash.slice(0, 16)}…`,
      );
    }
  });

  if (applied.length > expected.length) {
    problems.push(
      `database records ${applied.length} migrations but the journal has only ${expected.length}`,
    );
  }

  const pending = expected.slice(Math.min(applied.length, expected.length));
  const last = applied[applied.length - 1];
  for (const m of pending) {
    if (last && m.when <= last.createdAt) {
      problems.push(
        `pending ${m.tag}: "when" ${m.when} is not after the last applied ${last.createdAt}`,
      );
    }
  }

  return { problems, applied: applied.length, pending };
}
