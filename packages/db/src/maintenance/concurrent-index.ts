/**
 * A btree index on `public.messages` built CONCURRENTLY, outside any transaction,
 * and verified against the catalogue (never against the journal). Generalised from
 * U14.1a so that each index is a declarative spec; the policy is unchanged:
 *
 *   - absent            → CREATE INDEX CONCURRENTLY, then exact verification;
 *   - exact and valid   → accepted as is;
 *   - same definition but not valid/ready/live (an interrupted concurrent build)
 *                       → refused, unless `recoverInvalid`: then only that exact
 *                         target is dropped CONCURRENTLY, rebuilt and verified;
 *   - anything else (wrong definition, the name used elsewhere, an equivalent
 *     index under another name, a build in progress) → refused; nothing dropped.
 * There is no blocking fallback and no `IF NOT EXISTS`. Every entry point asserts
 * that the caller's connection holds the session-level migration lock.
 *
 * Specs: `messages-org-id-id-desc.ts` (U14.1a, guard 0042),
 * `messages-org-id-created-at.ts` (U14.1b, guard 0043) and
 * `message-attempts-delivery.ts` (Phase 5.0, guard 0045: two UNIQUE indexes on
 * `public.message_attempts`, one of them partial over a nullable column). The
 * optional spec fields below default to the original U14.1 behaviour, so the
 * existing specs are classified exactly as before.
 */
import type { ClientBase } from 'pg';

import { assertMigrationLockHeld } from '../cli/migration-lock';

export interface KeyColumn {
  readonly name: string;
  /** `format_type` of the column; it must also be NOT NULL. */
  readonly type: string;
  /** The type whose default btree operator class the index uses (`regtype` input). */
  readonly opclassType: string;
  /** Phase 5.0: the column may be NULL (default: it must be NOT NULL). */
  readonly nullable?: boolean;
  /** Phase 5.0: `pg_index.indcollation` for this key column (default 0; 100 = the default collation of a text column). */
  readonly collation?: number;
}

export interface ConcurrentIndexSpec {
  readonly schema: 'public';
  readonly table: 'messages' | 'message_attempts';
  readonly name: string;
  readonly columns: readonly KeyColumn[];
  /** `pg_index.indoption` per key column (0 = ASC NULLS LAST, 3 = DESC NULLS FIRST). */
  readonly indoption: readonly number[];
  /** Human-readable sort order, used in messages, e.g. "(org_id ASC, id DESC)". */
  readonly orderLabel: string;
  /** `pg_get_indexdef` of the exact index. */
  readonly definition: string;
  /** The runner command operators use to recover an INVALID index. */
  readonly recoveryCommand: string;
  /** Phase 5.0: a UNIQUE index (default false). */
  readonly unique?: boolean;
  /** Phase 5.0: a partial index; the predicate is pinned by `definition` (default: not partial). */
  readonly partial?: boolean;
  /**
   * Phase 5.0: names of constraints that may legitimately depend on this index (for example a
   * UNIQUE constraint attached with `USING INDEX`, or a foreign key referencing it). Default:
   * none — any constraint backed by the index is a mismatch, as in U14.1.
   */
  readonly allowedConstraints?: readonly string[];
  /** Phase 5.0: the journal tag that must be applied before the runner may act (default 0033). */
  readonly requiresMigration?: string;
}

export class IndexMaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexMaintenanceError';
  }
}

/** One row of the catalogue query for the object named `<schema>.<spec.name>`. */
export interface TargetRow {
  readonly relkind: string;
  readonly relpersistence: string;
  readonly isIndex: boolean;
  readonly tableSchema: string | null;
  readonly tableName: string | null;
  readonly amname: string | null;
  readonly indnatts: number | null;
  readonly indnkeyatts: number | null;
  readonly indkey: readonly number[] | null;
  readonly indoption: readonly number[] | null;
  readonly indclass: readonly number[] | null;
  readonly indcollation: readonly number[] | null;
  readonly indisunique: boolean | null;
  readonly indisprimary: boolean | null;
  readonly indisexclusion: boolean | null;
  readonly indimmediate: boolean | null;
  readonly hasPredicate: boolean | null;
  readonly hasExpressions: boolean | null;
  readonly indisvalid: boolean | null;
  readonly indisready: boolean | null;
  readonly indislive: boolean | null;
  readonly backsConstraint: boolean | null;
  /** Phase 5.0: names of the constraints whose `conindid` is this index (optional in fixtures). */
  readonly constraintNames?: readonly string[] | null;
  readonly definition: string | null;
}

export interface ColumnFacts {
  readonly attnum: number;
  readonly type: string;
  readonly notNull: boolean;
}

export interface CatalogueSnapshot {
  /** The table exists. */
  readonly tableExists: boolean;
  /** Per spec key column, in order: attnum / type / not-null, or null when absent. */
  readonly columns: readonly (ColumnFacts | null)[];
  /** Per spec key column, in order: OID of the default btree operator class of its `opclassType`. */
  readonly opclasses: readonly (number | null)[];
  /** The object with the spec's name, if any. */
  readonly target: TargetRow | null;
  /** Other indexes on the table with exactly the spec's key columns and sort options. */
  readonly equivalents: readonly string[];
  /** A CREATE INDEX on the table is in progress in another session. */
  readonly buildInProgress: boolean;
}

export type IndexState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'exact' }
  | { readonly kind: 'invalid'; readonly flags: string }
  | { readonly kind: 'mismatch'; readonly problems: readonly string[] };

export type EnsureResult = 'present' | 'created' | 'recovered';

export interface EnsureOptions {
  /** Owner decision U-1: only with this flag may an exact-definition INVALID index be dropped and rebuilt. */
  readonly recoverInvalid?: boolean;
  /** lock_timeout for the concurrent DDL's waits (ms); never unbounded. Default 10 minutes. */
  readonly buildLockTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

const arr = (v: readonly (number | null)[] | null | undefined): string => JSON.stringify(v ?? null);
const qualified = (spec: ConcurrentIndexSpec) => `${spec.schema}.${spec.table}`;
const columnList = (spec: ConcurrentIndexSpec) => spec.columns.map((c) => c.name).join(', ');
/** "the default uuid btree class" (U14.1a's wording) or "the default btree classes for (uuid, timestamptz)". */
const opclassLabel = (spec: ConcurrentIndexSpec) => {
  const types = [...new Set(spec.columns.map((c) => c.opclassType))];
  return types.length === 1
    ? `the default ${types[0]} btree class`
    : `the default btree classes for (${spec.columns.map((c) => c.opclassType).join(', ')})`;
};

/** Structural problems of the target, ignoring validity flags. Empty = the exact definition. */
function definitionProblems(
  spec: ConcurrentIndexSpec,
  s: CatalogueSnapshot,
  t: TargetRow,
): string[] {
  const n = spec.columns.length;
  if (!t.isIndex || t.relkind !== 'i')
    return [`${spec.schema}.${spec.name} exists but is not an index (relkind ${t.relkind})`];
  const p: string[] = [];
  if (t.tableSchema !== spec.schema || t.tableName !== spec.table)
    p.push(`it indexes ${t.tableSchema}.${t.tableName}, not ${qualified(spec)}`);
  if (t.amname !== 'btree') p.push(`access method is ${t.amname}, not btree`);
  if (t.indnatts !== n || t.indnkeyatts !== n)
    p.push(
      `has ${t.indnkeyatts} key and ${t.indnatts} total columns (expected ${n} and ${n}: no INCLUDE columns)`,
    );
  const keys = s.columns.map((c) => c?.attnum ?? -1);
  if (arr(t.indkey) !== arr(keys))
    p.push(`key columns ${arr(t.indkey)} are not (${columnList(spec)}) = ${arr(keys)}`);
  if (arr(t.indoption) !== arr(spec.indoption))
    p.push(`sort options ${arr(t.indoption)} are not ${arr(spec.indoption)} ${spec.orderLabel}`);
  if (s.opclasses.some((o) => o === null) || arr(t.indclass) !== arr(s.opclasses))
    p.push(`operator classes ${arr(t.indclass)} are not ${opclassLabel(spec)}`);
  const collations = spec.columns.map((c) => c.collation ?? 0);
  if (arr(t.indcollation) !== arr(collations))
    p.push(`collations ${arr(t.indcollation)} are not ${arr(collations)}`);
  const unique = spec.unique === true;
  if (t.indisunique !== unique) p.push(unique ? 'it is not UNIQUE' : 'it is UNIQUE');
  if (t.indisprimary !== false) p.push('it is a primary key');
  if (t.indisexclusion !== false) p.push('it is an exclusion index');
  if (t.indimmediate !== true) p.push('it is not immediate');
  const partial = spec.partial === true;
  if (t.hasPredicate !== partial)
    p.push(partial ? 'it is not partial (no predicate)' : 'it is partial (has a predicate)');
  if (t.hasExpressions !== false) p.push('it has expression columns');
  if (t.relpersistence !== 'p') p.push(`persistence is ${t.relpersistence}, not permanent`);
  if (spec.allowedConstraints === undefined) {
    if (t.backsConstraint !== false) p.push('it backs a constraint');
  } else {
    const allowed = new Set(spec.allowedConstraints);
    const unexpected = (t.constraintNames ?? []).filter((name) => !allowed.has(name));
    if (unexpected.length > 0)
      p.push(`it backs unexpected constraint(s): ${[...unexpected].sort().join(', ')}`);
  }
  if (p.length === 0 && t.definition !== spec.definition) {
    p.push(`definition "${t.definition}" differs from "${spec.definition}"`);
  }
  return p;
}

/** Pure classification of a catalogue snapshot. A definition mismatch wins over validity flags. */
export function classifyIndexFor(spec: ConcurrentIndexSpec, s: CatalogueSnapshot): IndexState {
  const t = s.target;
  if (!t) return { kind: 'absent' };
  const problems = definitionProblems(spec, s, t);
  if (problems.length > 0) return { kind: 'mismatch', problems };
  if (t.indisvalid === true && t.indisready === true && t.indislive === true)
    return { kind: 'exact' };
  return {
    kind: 'invalid',
    flags: `indisvalid=${t.indisvalid} indisready=${t.indisready} indislive=${t.indislive}`,
  };
}

/** Preflight problems with the table itself (it must exist with every key column of the right type, NOT NULL). */
export function tableProblemsFor(spec: ConcurrentIndexSpec, s: CatalogueSnapshot): string[] {
  if (!s.tableExists) return [`${qualified(spec)} does not exist`];
  const p: string[] = [];
  spec.columns.forEach((want, i) => {
    const col = s.columns[i];
    if (!col) p.push(`${qualified(spec)}.${want.name} does not exist`);
    else if (col.type !== want.type || (!want.nullable && !col.notNull))
      p.push(
        `${qualified(spec)}.${want.name} is ${col.type}${col.notNull ? ' NOT NULL' : ''}, expected ${want.type}${want.nullable ? '' : ' NOT NULL'}`,
      );
  });
  const missing = new Set(
    spec.columns.filter((_c, i) => s.opclasses[i] === null).map((c) => c.opclassType),
  );
  for (const type of missing) p.push(`no default btree operator class for ${type}`);
  return p;
}

const ints = (v: unknown): number[] | null =>
  v === null || v === undefined ? null : (v as Array<number | string>).map((x) => Number(x));

/** Reads everything the classification needs, on the given connection. */
export async function readIndexCatalogueFor(
  spec: ConcurrentIndexSpec,
  client: ClientBase,
): Promise<CatalogueSnapshot> {
  const table = await client.query<{ oid: string | null }>(
    `SELECT to_regclass($1)::oid::text AS oid`,
    [qualified(spec)],
  );
  const tableOid = table.rows[0]?.oid ?? null;
  const names = spec.columns.map((c) => c.name);
  const cols = tableOid
    ? (
        await client.query<{ attname: string; attnum: number; type: string; notnull: boolean }>(
          `SELECT attname, attnum, format_type(atttypid, atttypmod) AS type, attnotnull AS notnull
             FROM pg_attribute WHERE attrelid = $1::oid AND attname = ANY($2::text[]) AND NOT attisdropped`,
          [tableOid, names],
        )
      ).rows
    : [];
  const columns = names.map((name) => {
    const c = cols.find((r) => r.attname === name);
    return c ? { attnum: Number(c.attnum), type: c.type, notNull: c.notnull } : null;
  });
  const opclasses: (number | null)[] = [];
  for (const c of spec.columns) {
    const opc = await client.query<{ oid: string }>(
      `SELECT opc.oid::text AS oid FROM pg_opclass opc JOIN pg_am am ON am.oid = opc.opcmethod
        WHERE am.amname = 'btree' AND opc.opcintype = $1::regtype AND opc.opcdefault`,
      [c.opclassType],
    );
    opclasses.push(opc.rows[0] ? Number(opc.rows[0].oid) : null);
  }
  const target = await client.query(
    `SELECT ic.relkind::text AS relkind, ic.relpersistence::text AS relpersistence, (i.indexrelid IS NOT NULL) AS "isIndex",
            tn.nspname AS "tableSchema", t.relname AS "tableName", am.amname,
            i.indnatts, i.indnkeyatts,
            -- int2vector/oidvector keep lower bound 0 when cast to arrays; normalise via text to 1-based arrays.
            string_to_array(i.indkey::text, ' ')::int2[] AS indkey, string_to_array(i.indoption::text, ' ')::int2[] AS indoption,
            string_to_array(i.indclass::text, ' ')::int8[] AS indclass, string_to_array(i.indcollation::text, ' ')::int8[] AS indcollation,
            i.indisunique, i.indisprimary, i.indisexclusion, i.indimmediate,
            (i.indpred IS NOT NULL) AS "hasPredicate", (i.indexprs IS NOT NULL) AS "hasExpressions",
            i.indisvalid, i.indisready, i.indislive,
            CASE WHEN i.indexrelid IS NULL THEN NULL
                 ELSE EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) END AS "backsConstraint",
            CASE WHEN i.indexrelid IS NULL THEN NULL
                 ELSE ARRAY(SELECT c.conname::text FROM pg_constraint c WHERE c.conindid = i.indexrelid ORDER BY c.conname) END AS "constraintNames",
            CASE WHEN i.indexrelid IS NULL THEN NULL ELSE pg_get_indexdef(i.indexrelid) END AS definition
       FROM pg_class ic
       JOIN pg_namespace n ON n.oid = ic.relnamespace
       LEFT JOIN pg_index i ON i.indexrelid = ic.oid
       LEFT JOIN pg_class t ON t.oid = i.indrelid
       LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
       LEFT JOIN pg_am am ON am.oid = ic.relam
      WHERE n.nspname = $1 AND ic.relname = $2`,
    [spec.schema, spec.name],
  );
  const r = target.rows[0] as Record<string, unknown> | undefined;
  const equivalents =
    tableOid && columns.every((c) => c !== null)
      ? (
          await client.query<{ relname: string }>(
            `SELECT ic.relname FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
              WHERE i.indrelid = $1::oid AND ic.relname <> $2
                AND i.indnkeyatts = $3 AND string_to_array(i.indkey::text, ' ')::int2[] = $4::int2[]
                AND string_to_array(i.indoption::text, ' ')::int2[] = $5::int2[]
              ORDER BY ic.relname`,
            [
              tableOid,
              spec.name,
              spec.columns.length,
              columns.map((c) => c!.attnum),
              [...spec.indoption],
            ],
          )
        ).rows.map((x) => x.relname)
      : [];
  const progress = tableOid
    ? (
        await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_progress_create_index WHERE relid = $1::oid AND pid <> pg_backend_pid()`,
          [tableOid],
        )
      ).rows[0]?.n
    : '0';
  return {
    tableExists: tableOid !== null,
    columns,
    opclasses,
    target: r
      ? {
          relkind: String(r.relkind),
          relpersistence: String(r.relpersistence),
          isIndex: r.isIndex === true,
          tableSchema: (r.tableSchema as string | null) ?? null,
          tableName: (r.tableName as string | null) ?? null,
          amname: (r.amname as string | null) ?? null,
          indnatts: r.indnatts === null ? null : Number(r.indnatts),
          indnkeyatts: r.indnkeyatts === null ? null : Number(r.indnkeyatts),
          indkey: ints(r.indkey),
          indoption: ints(r.indoption),
          indclass: ints(r.indclass),
          indcollation: ints(r.indcollation),
          indisunique: r.indisunique as boolean | null,
          indisprimary: r.indisprimary as boolean | null,
          indisexclusion: r.indisexclusion as boolean | null,
          indimmediate: r.indimmediate as boolean | null,
          hasPredicate: r.hasPredicate as boolean | null,
          hasExpressions: r.hasExpressions as boolean | null,
          indisvalid: r.indisvalid as boolean | null,
          indisready: r.indisready as boolean | null,
          indislive: r.indislive as boolean | null,
          backsConstraint: r.backsConstraint as boolean | null,
          constraintNames: (r.constraintNames as string[] | null) ?? null,
          definition: (r.definition as string | null) ?? null,
        }
      : null,
    equivalents,
    buildInProgress: Number(progress ?? '0') > 0,
  };
}

export function describeFor(spec: ConcurrentIndexSpec, state: IndexState): string {
  const name = `${spec.schema}.${spec.name}`;
  switch (state.kind) {
    case 'absent':
      return `index ${name} is absent`;
    case 'exact':
      return `index ${name} is present, exact and valid`;
    case 'invalid':
      return `index ${name} has the expected definition but is not usable (${state.flags}) — an interrupted concurrent build`;
    case 'mismatch':
      return `${name} does not match the expected definition: ${state.problems.join('; ')}`;
  }
}

const recoveryHint = (spec: ConcurrentIndexSpec) =>
  `Recover with the concurrent index runner: ${spec.recoveryCommand}`;

/** Throws unless the exact, valid index exists now. */
export async function verifyIndexExactFor(
  spec: ConcurrentIndexSpec,
  client: ClientBase,
  context: string,
): Promise<void> {
  const snapshot = await readIndexCatalogueFor(spec, client);
  const state = classifyIndexFor(spec, snapshot);
  if (snapshot.equivalents.length > 0) {
    throw new IndexMaintenanceError(
      `${context}: unexpected index(es) with the same definition under another name: ${snapshot.equivalents.join(', ')}`,
    );
  }
  if (state.kind !== 'exact') {
    throw new IndexMaintenanceError(
      `${context}: ${describeFor(spec, state)}. ${state.kind === 'mismatch' ? 'Nothing was changed; resolve the conflicting object deliberately.' : recoveryHint(spec)}`,
    );
  }
}

/**
 * Runs one concurrent DDL statement with no statement timeout and a bounded lock wait. `lock_timeout = 0`
 * would mean "wait forever" in PostgreSQL, so the bound is at least 1 ms.
 */
async function concurrently(
  client: ClientBase,
  statement: string,
  lockTimeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(lockTimeoutMs)) {
    throw new IndexMaintenanceError(
      `invalid lock timeout for ${statement}: ${String(lockTimeoutMs)}`,
    );
  }
  try {
    await client.query('SET statement_timeout = 0');
    await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
    await client.query(statement);
  } finally {
    // Best effort: on a broken session these fail too, and the run discards the connection anyway.
    await client.query('RESET lock_timeout').catch(() => undefined);
    await client.query('RESET statement_timeout').catch(() => undefined);
  }
}

/** `CREATE INDEX CONCURRENTLY …` — the exact definition with CONCURRENTLY inserted. */
export function createSql(spec: ConcurrentIndexSpec): string {
  const kind = spec.unique === true ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  const prefix = `${kind} ${spec.name} `;
  if (!spec.definition.startsWith(prefix)) {
    throw new IndexMaintenanceError(`index spec ${spec.name}: unexpected definition shape`);
  }
  return `${kind} CONCURRENTLY ${spec.name} ${spec.definition.slice(prefix.length)}`;
}

export const dropSql = (spec: ConcurrentIndexSpec): string =>
  `DROP INDEX CONCURRENTLY ${spec.schema}.${spec.name}`;

/**
 * Makes the exact index exist, or refuses. Must run on the connection that
 * holds the migration lock, outside any transaction.
 */
export async function ensureIndexFor(
  spec: ConcurrentIndexSpec,
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  const log = options.log ?? (() => {});
  const lockTimeoutMs = options.buildLockTimeoutMs ?? 600_000;
  const read = () => readIndexCatalogueFor(spec, client);
  const classify = (s: CatalogueSnapshot) => classifyIndexFor(spec, s);
  const describe = (s: IndexState) => describeFor(spec, s);

  await assertMigrationLockHeld(client, 'index preflight');
  const snapshot = await read();
  const preflight = tableProblemsFor(spec, snapshot);
  if (preflight.length > 0) {
    throw new IndexMaintenanceError(`Refusing to build the index: ${preflight.join('; ')}`);
  }
  if (snapshot.equivalents.length > 0) {
    throw new IndexMaintenanceError(
      `Refusing: ${qualified(spec)} already has an index with the same definition under another name (${snapshot.equivalents.join(', ')}); it is not adopted silently.`,
    );
  }
  const state = classify(snapshot);
  if (state.kind === 'exact') {
    log(describe(state));
    return 'present';
  }
  if (state.kind === 'mismatch') {
    throw new IndexMaintenanceError(
      `Refusing: ${describe(state)}. Nothing was dropped or changed.`,
    );
  }
  if (snapshot.buildInProgress) {
    throw new IndexMaintenanceError(
      `Refusing: a CREATE INDEX on ${qualified(spec)} is in progress in another session (pg_stat_progress_create_index).`,
    );
  }
  let result: EnsureResult = 'created';
  if (state.kind === 'invalid') {
    if (!options.recoverInvalid) {
      throw new IndexMaintenanceError(`Refusing: ${describe(state)}. ${recoveryHint(spec)}`);
    }
    // Re-read immediately before the drop: only the verified exact-definition, not-valid target is dropped.
    await assertMigrationLockHeld(client, 'invalid-index recovery');
    const again = await read();
    const recheck = classify(again);
    if (recheck.kind !== 'invalid' || again.buildInProgress || again.equivalents.length > 0) {
      throw new IndexMaintenanceError(
        `Refusing recovery: the index changed before it could be dropped (${describe(recheck)}).`,
      );
    }
    log(`dropping the invalid ${spec.name} CONCURRENTLY (${recheck.flags})`);
    await concurrently(client, dropSql(spec), lockTimeoutMs);
    if (classify(await read()).kind !== 'absent') {
      throw new IndexMaintenanceError(
        'Refusing: the invalid index is still present after DROP INDEX CONCURRENTLY.',
      );
    }
    result = 'recovered';
  }
  await assertMigrationLockHeld(client, 'concurrent index build');
  try {
    log(`building ${spec.name} CONCURRENTLY (lock_timeout ${lockTimeoutMs} ms)`);
    await concurrently(client, createSql(spec), lockTimeoutMs);
  } catch (error) {
    const after = classify(await read());
    throw new IndexMaintenanceError(
      `The concurrent index build failed (${error instanceof Error ? error.message : String(error)}); ${describe(after)}. ${after.kind === 'invalid' ? recoveryHint(spec) : ''}`.trim(),
    );
  }
  await assertMigrationLockHeld(client, 'post-build verification');
  await verifyIndexExactFor(spec, client, 'post-build verification');
  log(`${spec.name}: ${result}, exact and valid`);
  return result;
}
