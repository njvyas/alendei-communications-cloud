import {
  classifyIndexFor,
  createSql,
  dropSql,
  tableProblemsFor,
  type CatalogueSnapshot,
  type TargetRow,
} from './concurrent-index';
import {
  MESSAGE_ATTEMPTS_DELIVERY_INDEXES,
  MESSAGE_ATTEMPTS_ID_MESSAGE_ID_UQ as ID_MSG,
  MESSAGE_ATTEMPTS_PROVIDER_MESSAGE_UQ as PROVIDER_MSG,
} from './message-attempts-delivery';
import { MESSAGES_ORG_ID_CREATED_AT } from './messages-org-id-created-at';
import { parseDeliveryIndexRunnerArgs } from '../cli/index-message-attempts-delivery';

/**
 * Phase 5.0 catalogue classification for the two UNIQUE indexes on message_attempts.
 * Every deviation from the exact index is a refusal; the optional spec fields
 * (unique, partial, nullable, collation, allowedConstraints) are exercised both ways.
 */
const PROVIDER = 4;
const PMID = 13;
const ID = 1;
const MESSAGE = 2;
const UUID_OPC = 10073;
const TEXT_OPC = 3126;

const target = (over: Partial<TargetRow>): TargetRow => ({
  relkind: 'i',
  relpersistence: 'p',
  isIndex: true,
  tableSchema: 'public',
  tableName: 'message_attempts',
  amname: 'btree',
  indnatts: 2,
  indnkeyatts: 2,
  indkey: [PROVIDER, PMID],
  indoption: [0, 0],
  indclass: [UUID_OPC, TEXT_OPC],
  indcollation: [0, 100],
  indisunique: true,
  indisprimary: false,
  indisexclusion: false,
  indimmediate: true,
  hasPredicate: true,
  hasExpressions: false,
  indisvalid: true,
  indisready: true,
  indislive: true,
  backsConstraint: false,
  constraintNames: [],
  definition: PROVIDER_MSG.definition,
  ...over,
});

const providerSnapshot = (
  t: TargetRow | null,
  extra: Partial<CatalogueSnapshot> = {},
): CatalogueSnapshot => ({
  tableExists: true,
  columns: [
    { attnum: PROVIDER, type: 'uuid', notNull: true },
    { attnum: PMID, type: 'text', notNull: false },
  ],
  opclasses: [UUID_OPC, TEXT_OPC],
  target: t,
  equivalents: [],
  buildInProgress: false,
  ...extra,
});

const idTarget = (over: Partial<TargetRow> = {}): TargetRow =>
  target({
    indkey: [ID, MESSAGE],
    indclass: [UUID_OPC, UUID_OPC],
    indcollation: [0, 0],
    hasPredicate: false,
    definition: ID_MSG.definition,
    ...over,
  });
const idSnapshot = (t: TargetRow | null): CatalogueSnapshot => ({
  tableExists: true,
  columns: [
    { attnum: ID, type: 'uuid', notNull: true },
    { attnum: MESSAGE, type: 'uuid', notNull: true },
  ],
  opclasses: [UUID_OPC, UUID_OPC],
  target: t,
  equivalents: [],
  buildInProgress: false,
});

describe('Phase 5.0 message_attempts_provider_message_uq — exact catalogue verification', () => {
  it('the approved shape: UNIQUE (provider_id, provider_message_id) WHERE provider_message_id IS NOT NULL', () => {
    expect(PROVIDER_MSG.definition).toBe(
      'CREATE UNIQUE INDEX message_attempts_provider_message_uq ON public.message_attempts USING btree (provider_id, provider_message_id) WHERE (provider_message_id IS NOT NULL)',
    );
    expect(createSql(PROVIDER_MSG)).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY message_attempts_provider_message_uq ON public.message_attempts USING btree (provider_id, provider_message_id) WHERE (provider_message_id IS NOT NULL)',
    );
    expect(dropSql(PROVIDER_MSG)).toBe(
      'DROP INDEX CONCURRENTLY public.message_attempts_provider_message_uq',
    );
    // The non-unique U14.1b statement is unchanged by the generalisation.
    expect(createSql(MESSAGES_ORG_ID_CREATED_AT)).toBe(
      'CREATE INDEX CONCURRENTLY messages_org_id_created_at_idx ON public.messages USING btree (org_id, created_at)',
    );
  });

  it('absent / exact', () => {
    expect(classifyIndexFor(PROVIDER_MSG, providerSnapshot(null))).toEqual({ kind: 'absent' });
    expect(classifyIndexFor(PROVIDER_MSG, providerSnapshot(target({})))).toEqual({ kind: 'exact' });
  });

  it.each<[string, Partial<TargetRow>, RegExp]>([
    ['not unique', { indisunique: false }, /it is not UNIQUE/],
    ['not partial', { hasPredicate: false }, /it is not partial/],
    ['default collation missing on the text column', { indcollation: [0, 0] }, /collations/],
    ['reversed columns', { indkey: [PMID, PROVIDER] }, /key columns/],
    ['other table', { tableName: 'messages' }, /not public\.message_attempts/],
    [
      'backs any constraint',
      { backsConstraint: true, constraintNames: ['x'] },
      /backs a constraint/,
    ],
    [
      'different predicate text',
      { definition: `${PROVIDER_MSG.definition} AND true` },
      /definition/,
    ],
  ])('%s → mismatch, refused', (_label, change, message) => {
    const state = classifyIndexFor(PROVIDER_MSG, providerSnapshot(target(change)));
    expect(state.kind).toBe('mismatch');
    expect(state.kind === 'mismatch' && state.problems.join('; ')).toMatch(message);
  });

  it('an interrupted concurrent build is invalid, not a mismatch', () => {
    expect(
      classifyIndexFor(PROVIDER_MSG, providerSnapshot(target({ indisvalid: false }))).kind,
    ).toBe('invalid');
  });

  it('accepts the nullable provider_message_id but still requires provider_id NOT NULL', () => {
    expect(tableProblemsFor(PROVIDER_MSG, providerSnapshot(null))).toEqual([]);
    const loose = providerSnapshot(null, {
      columns: [
        { attnum: PROVIDER, type: 'uuid', notNull: false },
        { attnum: PMID, type: 'text', notNull: false },
      ],
    });
    expect(tableProblemsFor(PROVIDER_MSG, loose).join('; ')).toMatch(
      /provider_id is uuid, expected uuid NOT NULL/,
    );
    const missing = providerSnapshot(null, {
      columns: [{ attnum: PROVIDER, type: 'uuid', notNull: true }, null],
    });
    expect(tableProblemsFor(PROVIDER_MSG, missing).join('; ')).toMatch(
      /provider_message_id does not exist/,
    );
  });
});

describe('Phase 5.0 uq_message_attempts_id_message_id — the composite FK target', () => {
  it('the approved shape and its single required migration', () => {
    expect(ID_MSG.definition).toBe(
      'CREATE UNIQUE INDEX uq_message_attempts_id_message_id ON public.message_attempts USING btree (id, message_id)',
    );
    expect(MESSAGE_ATTEMPTS_DELIVERY_INDEXES.map((s) => s.requiresMigration)).toEqual([
      '0044_phase5_0_delivery_foundation',
      '0044_phase5_0_delivery_foundation',
    ]);
  });

  it('is exact before 0046 (no constraint) and after 0046 (its own UNIQUE constraint + the delivered-attempt FK)', () => {
    expect(classifyIndexFor(ID_MSG, idSnapshot(idTarget()))).toEqual({ kind: 'exact' });
    expect(
      classifyIndexFor(
        ID_MSG,
        idSnapshot(
          idTarget({
            backsConstraint: true,
            constraintNames: ['messages_delivered_attempt_fk', 'uq_message_attempts_id_message_id'],
          }),
        ),
      ),
    ).toEqual({ kind: 'exact' });
  });

  it('refuses any other constraint depending on it', () => {
    const state = classifyIndexFor(
      ID_MSG,
      idSnapshot(
        idTarget({
          backsConstraint: true,
          constraintNames: ['uq_message_attempts_id_message_id', 'rogue_fk'],
        }),
      ),
    );
    expect(state.kind).toBe('mismatch');
    expect(state.kind === 'mismatch' && state.problems.join('; ')).toMatch(
      /unexpected constraint\(s\): rogue_fk/,
    );
  });

  it('refuses a non-unique or partial (id, message_id) index', () => {
    expect(classifyIndexFor(ID_MSG, idSnapshot(idTarget({ indisunique: false }))).kind).toBe(
      'mismatch',
    );
    expect(classifyIndexFor(ID_MSG, idSnapshot(idTarget({ hasPredicate: true }))).kind).toBe(
      'mismatch',
    );
  });
});

describe('db:index:message-attempts-delivery arguments', () => {
  it('accepts the three runner modes', () => {
    expect(parseDeliveryIndexRunnerArgs([])).toBe('ensure');
    expect(parseDeliveryIndexRunnerArgs(['--check'])).toBe('check');
    expect(parseDeliveryIndexRunnerArgs(['--recover-invalid'])).toBe('recover-invalid');
  });
});
