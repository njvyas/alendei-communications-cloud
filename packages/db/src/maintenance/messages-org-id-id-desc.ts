/**
 * U14.1a — `public.messages (org_id, id DESC)` built CONCURRENTLY, outside any
 * transaction, and verified against the catalogue (never against the journal).
 *
 * Used by the barrier in `db:migrate` (`schema-migrate.ts`) before migration
 * `0042_messages_org_id_id_desc_guard`, and by the standalone runner
 * (`cli/index-messages-org-id-desc.ts`). Both hold the session-level migration
 * lock on the same pinned connection; every entry point here asserts that.
 *
 * Policy (owner decisions U-1, U-3):
 *   - absent            → CREATE INDEX CONCURRENTLY, then exact verification;
 *   - exact and valid   → accepted as is;
 *   - same definition but not valid/ready/live (an interrupted concurrent build)
 *                       → refused, unless `recoverInvalid`: then only that exact
 *                         target is dropped CONCURRENTLY, rebuilt and verified;
 *   - anything else (wrong definition, the name used elsewhere, an equivalent
 *     index under another name, a build in progress) → refused; nothing dropped.
 * There is no blocking fallback and no `IF NOT EXISTS`.
 */
import type { ClientBase } from 'pg';

import { assertMigrationLockHeld } from '../cli/migration-lock';

export const MESSAGES_ORG_ID_ID_DESC = {
  schema: 'public',
  table: 'messages',
  name: 'messages_org_id_id_desc_idx',
  /** `pg_get_indexdef` of the exact index. */
  definition:
    'CREATE INDEX messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC)',
  /** `pg_index.indoption`: org_id ASC NULLS LAST = 0; id DESC (NULLS FIRST by default) = 3. */
  indoption: [0, 3] as const,
} as const;

const CREATE_SQL =
  'CREATE INDEX CONCURRENTLY messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC)';
const DROP_SQL = 'DROP INDEX CONCURRENTLY public.messages_org_id_id_desc_idx';

export class IndexMaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexMaintenanceError';
  }
}

/** One row of the catalogue query for the object named `public.messages_org_id_id_desc_idx`. */
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
  readonly definition: string | null;
}

export interface CatalogueSnapshot {
  /** `public.messages` exists. */
  readonly tableExists: boolean;
  /** attnum / type / not-null of the two key columns, when present. */
  readonly orgId: { attnum: number; type: string; notNull: boolean } | null;
  readonly id: { attnum: number; type: string; notNull: boolean } | null;
  /** OID of the default btree operator class for uuid. */
  readonly uuidOpclass: number | null;
  /** The object named public.messages_org_id_id_desc_idx, if any. */
  readonly target: TargetRow | null;
  /** Other indexes on public.messages whose keys are exactly (org_id, id DESC). */
  readonly equivalents: readonly string[];
  /** A CREATE INDEX on public.messages is in progress (pg_stat_progress_create_index). */
  readonly buildInProgress: boolean;
}

export type IndexState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'exact' }
  | { readonly kind: 'invalid'; readonly flags: string }
  | { readonly kind: 'mismatch'; readonly problems: readonly string[] };

const arr = (v: readonly number[] | null | undefined): string => JSON.stringify(v ?? null);

/** Structural problems of the target, ignoring validity flags. Empty = the exact definition. */
function definitionProblems(s: CatalogueSnapshot, t: TargetRow): string[] {
  const p: string[] = [];
  if (!t.isIndex || t.relkind !== 'i')
    return [
      `public.${MESSAGES_ORG_ID_ID_DESC.name} exists but is not an index (relkind ${t.relkind})`,
    ];
  if (t.tableSchema !== 'public' || t.tableName !== 'messages')
    p.push(`it indexes ${t.tableSchema}.${t.tableName}, not public.messages`);
  if (t.amname !== 'btree') p.push(`access method is ${t.amname}, not btree`);
  if (t.indnatts !== 2 || t.indnkeyatts !== 2)
    p.push(
      `has ${t.indnkeyatts} key and ${t.indnatts} total columns (expected 2 and 2: no INCLUDE columns)`,
    );
  const keys = [s.orgId?.attnum ?? -1, s.id?.attnum ?? -1];
  if (arr(t.indkey) !== arr(keys))
    p.push(`key columns ${arr(t.indkey)} are not (org_id, id) = ${arr(keys)}`);
  if (arr(t.indoption) !== arr(MESSAGES_ORG_ID_ID_DESC.indoption))
    p.push(`sort options ${arr(t.indoption)} are not [0,3] (org_id ASC, id DESC)`);
  if (s.uuidOpclass === null || arr(t.indclass) !== arr([s.uuidOpclass, s.uuidOpclass]))
    p.push(`operator classes ${arr(t.indclass)} are not the default uuid btree class`);
  if (arr(t.indcollation) !== arr([0, 0]))
    p.push(`collations ${arr(t.indcollation)} are not [0,0]`);
  if (t.indisunique !== false) p.push('it is UNIQUE');
  if (t.indisprimary !== false) p.push('it is a primary key');
  if (t.indisexclusion !== false) p.push('it is an exclusion index');
  if (t.indimmediate !== true) p.push('it is not immediate');
  if (t.hasPredicate !== false) p.push('it is partial (has a predicate)');
  if (t.hasExpressions !== false) p.push('it has expression columns');
  if (t.relpersistence !== 'p') p.push(`persistence is ${t.relpersistence}, not permanent`);
  if (t.backsConstraint !== false) p.push('it backs a constraint');
  if (p.length === 0 && t.definition !== MESSAGES_ORG_ID_ID_DESC.definition) {
    p.push(`definition "${t.definition}" differs from "${MESSAGES_ORG_ID_ID_DESC.definition}"`);
  }
  return p;
}

/** Pure classification of a catalogue snapshot. */
export function classifyIndex(s: CatalogueSnapshot): IndexState {
  const t = s.target;
  if (!t) return { kind: 'absent' };
  const problems = definitionProblems(s, t);
  if (problems.length > 0) return { kind: 'mismatch', problems };
  if (t.indisvalid === true && t.indisready === true && t.indislive === true)
    return { kind: 'exact' };
  return {
    kind: 'invalid',
    flags: `indisvalid=${t.indisvalid} indisready=${t.indisready} indislive=${t.indislive}`,
  };
}

/** Preflight problems with the table itself (it must exist with the two uuid NOT NULL key columns). */
export function tableProblems(s: CatalogueSnapshot): string[] {
  const p: string[] = [];
  if (!s.tableExists) return ['public.messages does not exist'];
  for (const [name, col] of [
    ['org_id', s.orgId],
    ['id', s.id],
  ] as const) {
    if (!col) p.push(`public.messages.${name} does not exist`);
    else if (col.type !== 'uuid' || !col.notNull)
      p.push(
        `public.messages.${name} is ${col.type}${col.notNull ? ' NOT NULL' : ''}, expected uuid NOT NULL`,
      );
  }
  if (s.uuidOpclass === null) p.push('no default btree operator class for uuid');
  return p;
}

const int2 = (v: unknown): number[] | null =>
  v === null || v === undefined ? null : (v as Array<number | string>).map((x) => Number(x));

/** Reads everything the classification needs, on the given connection. */
export async function readIndexCatalogue(client: ClientBase): Promise<CatalogueSnapshot> {
  const table = await client.query<{ oid: string | null }>(
    `SELECT to_regclass('public.messages')::oid::text AS oid`,
  );
  const tableOid = table.rows[0]?.oid ?? null;
  const cols = tableOid
    ? (
        await client.query<{ attname: string; attnum: number; type: string; notnull: boolean }>(
          `SELECT attname, attnum, format_type(atttypid, atttypmod) AS type, attnotnull AS notnull
             FROM pg_attribute WHERE attrelid = $1::oid AND attname IN ('org_id', 'id') AND NOT attisdropped`,
          [tableOid],
        )
      ).rows
    : [];
  const col = (name: string) => {
    const c = cols.find((r) => r.attname === name);
    return c ? { attnum: Number(c.attnum), type: c.type, notNull: c.notnull } : null;
  };
  const opc = await client.query<{ oid: string }>(
    `SELECT opc.oid::text AS oid FROM pg_opclass opc JOIN pg_am am ON am.oid = opc.opcmethod
      WHERE am.amname = 'btree' AND opc.opcintype = 'uuid'::regtype AND opc.opcdefault`,
  );
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
            CASE WHEN i.indexrelid IS NULL THEN NULL ELSE pg_get_indexdef(i.indexrelid) END AS definition
       FROM pg_class ic
       JOIN pg_namespace n ON n.oid = ic.relnamespace
       LEFT JOIN pg_index i ON i.indexrelid = ic.oid
       LEFT JOIN pg_class t ON t.oid = i.indrelid
       LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace
       LEFT JOIN pg_am am ON am.oid = ic.relam
      WHERE n.nspname = $1 AND ic.relname = $2`,
    [MESSAGES_ORG_ID_ID_DESC.schema, MESSAGES_ORG_ID_ID_DESC.name],
  );
  const r = target.rows[0] as Record<string, unknown> | undefined;
  const orgId = col('org_id');
  const id = col('id');
  const equivalents =
    tableOid && orgId && id
      ? (
          await client.query<{ relname: string }>(
            `SELECT ic.relname FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
              WHERE i.indrelid = $1::oid AND ic.relname <> $2
                AND i.indnkeyatts = 2 AND string_to_array(i.indkey::text, ' ')::int2[] = ARRAY[$3, $4]::int2[]
                AND string_to_array(i.indoption::text, ' ')::int2[] = ARRAY[0, 3]::int2[]
              ORDER BY ic.relname`,
            [tableOid, MESSAGES_ORG_ID_ID_DESC.name, orgId.attnum, id.attnum],
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
    orgId,
    id,
    uuidOpclass: opc.rows[0] ? Number(opc.rows[0].oid) : null,
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
          indkey: int2(r.indkey),
          indoption: int2(r.indoption),
          indclass: int2(r.indclass),
          indcollation: int2(r.indcollation),
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
          definition: (r.definition as string | null) ?? null,
        }
      : null,
    equivalents,
    buildInProgress: Number(progress ?? '0') > 0,
  };
}

export interface EnsureOptions {
  /** Owner decision U-1: only with this flag may an exact-definition INVALID index be dropped and rebuilt. */
  readonly recoverInvalid?: boolean;
  /** lock_timeout for the concurrent build's waits (ms); 0 = unbounded. Default 10 minutes. */
  readonly buildLockTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export type EnsureResult = 'present' | 'created' | 'recovered';

const RECOVERY_HINT =
  'Recover with the concurrent index runner: npm run db:index:messages-org-id-desc --workspace @acc/db -- --recover-invalid';

/** Throws unless the exact, valid index exists now. */
export async function verifyIndexExact(client: ClientBase, context: string): Promise<void> {
  const snapshot = await readIndexCatalogue(client);
  const state = classifyIndex(snapshot);
  if (snapshot.equivalents.length > 0) {
    throw new IndexMaintenanceError(
      `${context}: unexpected index(es) with the same definition under another name: ${snapshot.equivalents.join(', ')}`,
    );
  }
  if (state.kind !== 'exact') {
    throw new IndexMaintenanceError(
      `${context}: ${describe(state)}. ${state.kind === 'mismatch' ? 'Nothing was changed; resolve the conflicting object deliberately.' : RECOVERY_HINT}`,
    );
  }
}

export function describe(state: IndexState): string {
  switch (state.kind) {
    case 'absent':
      return `index public.${MESSAGES_ORG_ID_ID_DESC.name} is absent`;
    case 'exact':
      return `index public.${MESSAGES_ORG_ID_ID_DESC.name} is present, exact and valid`;
    case 'invalid':
      return `index public.${MESSAGES_ORG_ID_ID_DESC.name} has the expected definition but is not usable (${state.flags}) — an interrupted concurrent build`;
    case 'mismatch':
      return `public.${MESSAGES_ORG_ID_ID_DESC.name} does not match the expected definition: ${state.problems.join('; ')}`;
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
  await client.query('SET statement_timeout = 0');
  await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
  try {
    await client.query(statement);
  } finally {
    await client.query('RESET lock_timeout');
    await client.query('RESET statement_timeout');
  }
}

async function build(
  client: ClientBase,
  lockTimeoutMs: number,
  log: (l: string) => void,
): Promise<void> {
  log(`building ${MESSAGES_ORG_ID_ID_DESC.name} CONCURRENTLY (lock_timeout ${lockTimeoutMs} ms)`);
  await concurrently(client, CREATE_SQL, lockTimeoutMs);
}

/**
 * Makes the exact index exist, or refuses. Must run on the connection that
 * holds the migration lock, outside any transaction.
 */
export async function ensureMessagesOrgIdIdDescIndex(
  client: ClientBase,
  options: EnsureOptions = {},
): Promise<EnsureResult> {
  const log = options.log ?? (() => {});
  const lockTimeoutMs = options.buildLockTimeoutMs ?? 600_000;
  await assertMigrationLockHeld(client, 'index preflight');
  const snapshot = await readIndexCatalogue(client);
  const preflight = tableProblems(snapshot);
  if (preflight.length > 0) {
    throw new IndexMaintenanceError(`Refusing to build the index: ${preflight.join('; ')}`);
  }
  if (snapshot.equivalents.length > 0) {
    throw new IndexMaintenanceError(
      `Refusing: public.messages already has an index with the same definition under another name (${snapshot.equivalents.join(', ')}); it is not adopted silently.`,
    );
  }
  const state = classifyIndex(snapshot);
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
      'Refusing: a CREATE INDEX on public.messages is in progress in another session (pg_stat_progress_create_index).',
    );
  }
  let result: EnsureResult = 'created';
  if (state.kind === 'invalid') {
    if (!options.recoverInvalid) {
      throw new IndexMaintenanceError(`Refusing: ${describe(state)}. ${RECOVERY_HINT}`);
    }
    // Re-read immediately before the drop: only the verified exact-definition, not-valid target is dropped.
    await assertMigrationLockHeld(client, 'invalid-index recovery');
    const again = await readIndexCatalogue(client);
    const recheck = classifyIndex(again);
    if (recheck.kind !== 'invalid' || again.buildInProgress || again.equivalents.length > 0) {
      throw new IndexMaintenanceError(
        `Refusing recovery: the index changed before it could be dropped (${describe(recheck)}).`,
      );
    }
    log(`dropping the invalid ${MESSAGES_ORG_ID_ID_DESC.name} CONCURRENTLY (${recheck.flags})`);
    await concurrently(client, DROP_SQL, lockTimeoutMs);
    if (classifyIndex(await readIndexCatalogue(client)).kind !== 'absent') {
      throw new IndexMaintenanceError(
        'Refusing: the invalid index is still present after DROP INDEX CONCURRENTLY.',
      );
    }
    result = 'recovered';
  }
  await assertMigrationLockHeld(client, 'concurrent index build');
  try {
    await build(client, lockTimeoutMs, log);
  } catch (error) {
    const after = classifyIndex(await readIndexCatalogue(client));
    throw new IndexMaintenanceError(
      `The concurrent index build failed (${error instanceof Error ? error.message : String(error)}); ${describe(after)}. ${after.kind === 'invalid' ? RECOVERY_HINT : ''}`.trim(),
    );
  }
  await assertMigrationLockHeld(client, 'post-build verification');
  await verifyIndexExact(client, 'post-build verification');
  log(`${MESSAGES_ORG_ID_ID_DESC.name}: ${result}, exact and valid`);
  return result;
}
