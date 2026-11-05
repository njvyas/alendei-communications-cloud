import {
  MESSAGES_ORG_ID_ID_DESC,
  classifyIndex,
  tableProblems,
  type CatalogueSnapshot,
  type TargetRow,
} from './messages-org-id-id-desc';
import { parseRunnerArgs } from '../cli/index-messages-org-id-desc';

/** U14.1a catalogue classification: every single deviation from the exact index is a refusal. */
const ORG = 3;
const ID = 1;
const UUID_OPC = 10073;

const exactTarget: TargetRow = {
  relkind: 'i',
  relpersistence: 'p',
  isIndex: true,
  tableSchema: 'public',
  tableName: 'messages',
  amname: 'btree',
  indnatts: 2,
  indnkeyatts: 2,
  indkey: [ORG, ID],
  indoption: [0, 3],
  indclass: [UUID_OPC, UUID_OPC],
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
  definition: MESSAGES_ORG_ID_ID_DESC.definition,
};

const snapshot = (
  target: TargetRow | null,
  extra: Partial<CatalogueSnapshot> = {},
): CatalogueSnapshot => ({
  tableExists: true,
  orgId: { attnum: ORG, type: 'uuid', notNull: true },
  id: { attnum: ID, type: 'uuid', notNull: true },
  uuidOpclass: UUID_OPC,
  target,
  equivalents: [],
  buildInProgress: false,
  ...extra,
});

describe('classifyIndex — exact catalogue verification (U14.1a)', () => {
  it('absent when nothing has the name', () => {
    expect(classifyIndex(snapshot(null))).toEqual({ kind: 'absent' });
  });

  it('exact only when every attribute matches and it is valid, ready and live', () => {
    expect(classifyIndex(snapshot(exactTarget))).toEqual({ kind: 'exact' });
  });

  it.each<[string, Partial<TargetRow>, RegExp]>([
    ['not an index', { isIndex: false, relkind: 'r' }, /is not an index/],
    ['other table', { tableName: 'message_attempts' }, /not public\.messages/],
    ['other schema', { tableSchema: 'audit' }, /not public\.messages/],
    ['hash access method', { amname: 'hash' }, /not btree/],
    ['INCLUDE column', { indnatts: 3 }, /no INCLUDE columns/],
    ['one key column', { indnkeyatts: 1, indnatts: 1, indkey: [ORG] }, /key and/],
    ['reversed column order', { indkey: [ID, ORG] }, /not \(org_id, id\)/],
    ['id ascending', { indoption: [0, 0] }, /sort options/],
    ['org_id descending', { indoption: [3, 3] }, /sort options/],
    ['NULLS LAST on id', { indoption: [0, 1] }, /sort options/],
    ['non-default operator class', { indclass: [UUID_OPC, 99999] }, /operator classes/],
    ['collation set', { indcollation: [0, 100] }, /collations/],
    ['unique', { indisunique: true }, /UNIQUE/],
    ['primary key', { indisprimary: true }, /primary key/],
    ['exclusion', { indisexclusion: true }, /exclusion/],
    ['deferred', { indimmediate: false }, /not immediate/],
    ['partial', { hasPredicate: true }, /partial/],
    ['expressions', { hasExpressions: true }, /expression/],
    ['unlogged', { relpersistence: 'u' }, /persistence/],
    ['backs a constraint', { backsConstraint: true }, /backs a constraint/],
    [
      'different definition text',
      {
        definition:
          'CREATE INDEX messages_org_id_id_desc_idx ON public.messages USING btree (org_id, id DESC) WITH (fillfactor=50)',
      },
      /definition/,
    ],
  ])('%s → mismatch, refused', (_label, change, message) => {
    const state = classifyIndex(snapshot({ ...exactTarget, ...change }));
    expect(state.kind).toBe('mismatch');
    expect(state.kind === 'mismatch' && state.problems.join('; ')).toMatch(message);
  });

  it.each<[string, Partial<TargetRow>]>([
    ['not valid (interrupted build)', { indisvalid: false }],
    ['not ready', { indisready: false, indisvalid: false }],
    ['not live', { indislive: false }],
  ])(
    'exact definition but %s → invalid (recoverable only with --recover-invalid)',
    (_label, change) => {
      expect(classifyIndex(snapshot({ ...exactTarget, ...change })).kind).toBe('invalid');
    },
  );

  it('a definition mismatch wins over validity flags (an invalid but different index is never "recoverable")', () => {
    expect(
      classifyIndex(snapshot({ ...exactTarget, indisvalid: false, indisunique: true })).kind,
    ).toBe('mismatch');
  });

  it('table preflight: missing table, missing column, wrong type, nullable', () => {
    expect(tableProblems(snapshot(null, { tableExists: false }))).toEqual([
      'public.messages does not exist',
    ]);
    expect(tableProblems(snapshot(null, { id: null }))).toEqual([
      'public.messages.id does not exist',
    ]);
    expect(
      tableProblems(snapshot(null, { orgId: { attnum: ORG, type: 'text', notNull: true } }))[0],
    ).toMatch(/expected uuid NOT NULL/);
    expect(
      tableProblems(snapshot(null, { orgId: { attnum: ORG, type: 'uuid', notNull: false } }))[0],
    ).toMatch(/expected uuid NOT NULL/);
    expect(tableProblems(snapshot(null))).toEqual([]);
  });
});

describe('index runner arguments', () => {
  it('accepts exactly one of the three modes', () => {
    expect(parseRunnerArgs([])).toBe('ensure');
    expect(parseRunnerArgs(['--check'])).toBe('check');
    expect(parseRunnerArgs(['--recover-invalid'])).toBe('recover-invalid');
    for (const bad of [['--force'], ['--check', '--recover-invalid'], ['--drop'], ['x']]) {
      expect(() => parseRunnerArgs(bad)).toThrow(/usage/);
    }
  });
});
