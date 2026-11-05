import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  classifyIndexFor,
  createSql,
  dropSql,
  tableProblemsFor,
  type CatalogueSnapshot,
  type TargetRow,
} from './concurrent-index';
import { MESSAGES_ORG_ID_CREATED_AT as SPEC } from './messages-org-id-created-at';
import { MESSAGES_ORG_ID_ID_DESC } from './messages-org-id-id-desc';
import { parseCreatedAtRunnerArgs } from '../cli/index-messages-org-created-at';

/** U14.1b catalogue classification: every single deviation from the exact index is a refusal. */
const ORG = 3;
const CREATED = 14;
const UUID_OPC = 10073;
const TS_OPC = 3127;

const exactTarget: TargetRow = {
  relkind: 'i',
  relpersistence: 'p',
  isIndex: true,
  tableSchema: 'public',
  tableName: 'messages',
  amname: 'btree',
  indnatts: 2,
  indnkeyatts: 2,
  indkey: [ORG, CREATED],
  indoption: [0, 0],
  indclass: [UUID_OPC, TS_OPC],
  indcollation: [0, 0],
  indisunique: false,
  indisprimary: false,
  indisexclusion: false,
  indimmediate: true,
  hasPredicate: false,
  hasExpressions: false,
  indisvalid: true,
  indisready: true,
  indislive: true,
  backsConstraint: false,
  definition: SPEC.definition,
};

const snapshot = (
  target: TargetRow | null,
  extra: Partial<CatalogueSnapshot> = {},
): CatalogueSnapshot => ({
  tableExists: true,
  columns: [
    { attnum: ORG, type: 'uuid', notNull: true },
    { attnum: CREATED, type: 'timestamp with time zone', notNull: true },
  ],
  opclasses: [UUID_OPC, TS_OPC],
  target,
  equivalents: [],
  buildInProgress: false,
  ...extra,
});
const classify = (s: CatalogueSnapshot) => classifyIndexFor(SPEC, s);

describe('U14.1b messages_org_id_created_at_idx — exact catalogue verification', () => {
  it('the approved shape: (org_id, created_at), both ascending, plain btree', () => {
    expect(SPEC.definition).toBe(
      'CREATE INDEX messages_org_id_created_at_idx ON public.messages USING btree (org_id, created_at)',
    );
    expect(SPEC.indoption).toEqual([0, 0]);
    expect(createSql(SPEC)).toBe(
      'CREATE INDEX CONCURRENTLY messages_org_id_created_at_idx ON public.messages USING btree (org_id, created_at)',
    );
    expect(dropSql(SPEC)).toBe('DROP INDEX CONCURRENTLY public.messages_org_id_created_at_idx');
    // The U14.1a statements are byte-for-byte what U14.1a issued before the generalisation.
    expect(createSql(MESSAGES_ORG_ID_ID_DESC)).toBe(
      'CREATE INDEX CONCURRENTLY messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC)',
    );
    expect(dropSql(MESSAGES_ORG_ID_ID_DESC)).toBe(
      'DROP INDEX CONCURRENTLY public.messages_org_id_id_desc_idx',
    );
  });

  it('absent / exact', () => {
    expect(classify(snapshot(null))).toEqual({ kind: 'absent' });
    expect(classify(snapshot(exactTarget))).toEqual({ kind: 'exact' });
  });

  it.each<[string, Partial<TargetRow>, RegExp]>([
    ['not an index', { isIndex: false, relkind: 'r' }, /is not an index/],
    ['other table', { tableName: 'message_attempts' }, /not public\.messages/],
    ['hash access method', { amname: 'hash' }, /not btree/],
    ['INCLUDE column (the rejected id tail)', { indnatts: 3 }, /no INCLUDE columns/],
    [
      'three key columns: (org_id, created_at, id) — the originally named shape',
      { indnkeyatts: 3, indnatts: 3, indkey: [ORG, CREATED, 1] },
      /key and/,
    ],
    ['reversed column order', { indkey: [CREATED, ORG] }, /not \(org_id, created_at\)/],
    ['created_at descending', { indoption: [0, 3] }, /sort options/],
    ['org_id descending', { indoption: [3, 0] }, /sort options/],
    ['NULLS FIRST on created_at', { indoption: [0, 2] }, /sort options/],
    [
      'non-default operator class',
      { indclass: [UUID_OPC, 99999] },
      /are not the default btree classes for \(uuid, timestamptz\)/,
    ],
    ['collation set', { indcollation: [0, 100] }, /collations/],
    ['unique', { indisunique: true }, /UNIQUE/],
    ['partial', { hasPredicate: true }, /partial/],
    ['expressions', { hasExpressions: true }, /expression/],
    ['unlogged', { relpersistence: 'u' }, /persistence/],
    ['backs a constraint', { backsConstraint: true }, /backs a constraint/],
    [
      'different definition text',
      { definition: `${SPEC.definition} WITH (fillfactor=50)` },
      /definition/,
    ],
  ])('%s → mismatch, refused', (_label, change, message) => {
    const state = classify(snapshot({ ...exactTarget, ...change }));
    expect(state.kind).toBe('mismatch');
    expect(state.kind === 'mismatch' && state.problems.join('; ')).toMatch(message);
  });

  it.each<[string, Partial<TargetRow>]>([
    ['not valid (interrupted build)', { indisvalid: false }],
    ['not ready', { indisready: false, indisvalid: false }],
    ['not live', { indislive: false }],
  ])('exact definition but %s → invalid', (_label, change) => {
    expect(classify(snapshot({ ...exactTarget, ...change })).kind).toBe('invalid');
  });

  it('a definition mismatch wins over validity flags', () => {
    expect(classify(snapshot({ ...exactTarget, indisvalid: false, indoption: [0, 3] })).kind).toBe(
      'mismatch',
    );
  });

  it('table preflight: created_at must be timestamptz NOT NULL with a default btree class', () => {
    const ts = (c: { type: string; notNull: boolean } | null) =>
      snapshot(null, {
        columns: [{ attnum: ORG, type: 'uuid', notNull: true }, c && { attnum: CREATED, ...c }],
      });
    expect(tableProblemsFor(SPEC, snapshot(null))).toEqual([]);
    expect(tableProblemsFor(SPEC, ts(null))).toEqual(['public.messages.created_at does not exist']);
    expect(
      tableProblemsFor(SPEC, ts({ type: 'timestamp without time zone', notNull: true }))[0],
    ).toMatch(/expected timestamp with time zone NOT NULL/);
    expect(
      tableProblemsFor(SPEC, ts({ type: 'timestamp with time zone', notNull: false }))[0],
    ).toMatch(/expected timestamp with time zone NOT NULL/);
    expect(tableProblemsFor(SPEC, snapshot(null, { opclasses: [UUID_OPC, null] }))).toEqual([
      'no default btree operator class for timestamptz',
    ]);
    expect(tableProblemsFor(SPEC, snapshot(null, { tableExists: false }))).toEqual([
      'public.messages does not exist',
    ]);
  });
});

describe('U14.1b guard migration 0043', () => {
  const guard = readFileSync(
    resolve(__dirname, '../../migrations/0043_messages_org_id_created_at_guard.sql'),
    'utf8',
  );
  const code = guard
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

  it('is a guard only: no DDL, no statement breakpoints, one DO block', () => {
    const outsideLiterals = code.replace(/'(?:[^']|'')*'/g, "''");
    expect(outsideLiterals).not.toMatch(/\b(CREATE|DROP|ALTER|REINDEX|TRUNCATE|GRANT|REVOKE)\b/i);
    expect(guard).not.toMatch(/statement-breakpoint/);
    expect(code.match(/\bDO \$guard\$/g)).toHaveLength(1);
  });

  it('checks the exact approved definition, keys, sort options and operator classes', () => {
    expect(code).toContain(`'${SPEC.definition}'`);
    expect(code).toContain('ARRAY[org_att, ts_att]::int2[]');
    expect(code).toContain('ARRAY[0, 0]::int2[]');
    expect(code).toContain("'timestamptz'::regtype");
    expect(code).toContain("ic.relname = 'messages_org_id_created_at_idx'");
  });
});

describe('U14.1b index runner arguments', () => {
  it('accepts exactly one of the three modes', () => {
    expect(parseCreatedAtRunnerArgs([])).toBe('ensure');
    expect(parseCreatedAtRunnerArgs(['--check'])).toBe('check');
    expect(parseCreatedAtRunnerArgs(['--recover-invalid'])).toBe('recover-invalid');
    for (const bad of [['--force'], ['--check', '--recover-invalid'], ['--drop']]) {
      expect(() => parseCreatedAtRunnerArgs(bad)).toThrow(
        /usage: db:index:messages-org-created-at/,
      );
    }
  });
});
