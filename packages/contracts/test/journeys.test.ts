/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mutate arbitrary, deliberately invalid graph shapes */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY_GRAPH_LIMITS,
  JOURNEY_NODE_CATALOGUE,
  JOURNEY_NODE_EDGES,
  canonicalJourneyJson,
  defaultJourneyGraph,
  isJourneyTimeZone,
  validateJourneyGraph,
} from '../src/journeys';

const T = '0193f000-0000-7000-8000-000000000001';
const S = '0193f000-0000-7000-8000-000000000002';

/** A valid graph exercising most node types. */
function full(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: {
        type: 'entry',
        trigger: { kind: 'event', event: 'contact.created' },
        next: 'welcome',
      },
      welcome: {
        type: 'send_message',
        channel: 'whatsapp',
        templateId: T,
        variables: { name: { source: 'contact_field', field: 'firstName' } },
        onSuppressed: 'continue',
        onRefused: 'exit',
        next: 'wait',
      },
      wait: {
        type: 'wait_for_outcome',
        sendNodeKey: 'welcome',
        outcome: 'read',
        timeoutSeconds: 3600,
        onOutcome: 'tag',
        onTimeout: 'pause',
      },
      pause: { type: 'wait_duration', seconds: 86400, next: 'check' },
      check: {
        type: 'condition',
        rule: { kind: 'send_outcome', sendNodeKey: 'welcome', outcome: 'delivered' },
        onTrue: 'tag',
        onFalse: 'window',
      },
      window: {
        type: 'wait_window',
        startTime: '09:00',
        endTime: '18:00',
        daysOfWeek: [1, 2, 3, 4, 5],
        timeZone: 'Asia/Kolkata',
        next: 'hook',
      },
      hook: { type: 'webhook', label: 'notify CRM', next: 'done' },
      tag: {
        type: 'update_contact',
        operations: [
          { op: 'add_tag', tag: 'engaged' },
          {
            op: 'set_attribute',
            field: 'custom.stage',
            value: { source: 'literal', value: 'warm' },
          },
        ],
        next: 'seg',
      },
      seg: {
        type: 'condition',
        rule: { kind: 'segment', segmentId: S, member: true },
        onTrue: 'done',
        onFalse: 'done',
      },
      done: { type: 'exit' },
    },
  };
}
const codes = (g: unknown) =>
  validateJourneyGraph(g)
    .errors.map((e) => e.code)
    .sort();
const mutate = (fn: (g: any) => void) => {
  const g: any = full();
  fn(g);
  return g;
};

describe('journey graph contract (8C-1)', () => {
  it('the default graph and the full example are valid', () => {
    assert.deepEqual(validateJourneyGraph(defaultJourneyGraph()), {
      valid: true,
      errors: [],
      warnings: [],
    });
    const r = validateJourneyGraph(full());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  it('placeholder nodes are warnings, never errors (owner decision 3)', () => {
    const r = validateJourneyGraph(full());
    assert.deepEqual(
      r.warnings.map((w) => [w.code, w.nodeKey]),
      [['PLACEHOLDER_NODE', 'hook']],
    );
    for (const t of ['webhook', 'crm_action', 'human_handoff', 'ai_handoff'] as const)
      assert.equal(JOURNEY_NODE_CATALOGUE[t].placeholder, true);
    assert.equal(JOURNEY_NODE_CATALOGUE.send_message.placeholder, false);
  });

  it('every node type has an edge list and a catalogue entry', () => {
    assert.deepEqual(
      Object.keys(JOURNEY_NODE_EDGES).sort(),
      Object.keys(JOURNEY_NODE_CATALOGUE).sort(),
    );
  });

  it('refuses non-objects, unsupported versions and oversize graphs early', () => {
    assert.deepEqual(codes(null), ['GRAPH_NOT_OBJECT']);
    assert.deepEqual(codes([]), ['GRAPH_NOT_OBJECT']);
    assert.deepEqual(codes({ ...full(), schemaVersion: 2 }), ['SCHEMA_VERSION_UNSUPPORTED']);
    const big = mutate(
      (g) => (g.nodes.start.label = 'x'.repeat(JOURNEY_GRAPH_LIMITS.maxSerializedLength)),
    );
    assert.deepEqual(codes(big), ['GRAPH_TOO_LARGE']);
  });

  it('limits the node count', () => {
    const nodes: Record<string, unknown> = {
      start: { type: 'entry', trigger: { kind: 'api' }, next: 'n0' },
    };
    for (let i = 0; i < JOURNEY_GRAPH_LIMITS.maxNodes; i++)
      nodes[`n${i}`] =
        i === JOURNEY_GRAPH_LIMITS.maxNodes - 1
          ? { type: 'exit' }
          : { type: 'wait_duration', seconds: 60, next: `n${i + 1}` };
    assert.deepEqual(codes({ schemaVersion: 1, entry: 'start', nodes }), ['TOO_MANY_NODES']);
  });

  it('entry: missing, duplicated, or targeted by an edge', () => {
    assert.ok(codes(mutate((g) => (g.entry = 'done'))).includes('ENTRY_MISSING'));
    assert.ok(codes(mutate((g) => (g.entry = 'nope'))).includes('ENTRY_MISSING'));
    assert.ok(
      codes(
        mutate((g) => (g.nodes.extra = { type: 'entry', trigger: { kind: 'api' }, next: 'done' })),
      ).includes('MULTIPLE_ENTRY_NODES'),
    );
    assert.ok(codes(mutate((g) => (g.nodes.pause.next = 'start'))).includes('EDGE_TO_ENTRY'));
  });

  it('edges: missing and unknown targets', () => {
    assert.ok(codes(mutate((g) => delete g.nodes.pause.next)).includes('EDGE_MISSING'));
    assert.ok(
      codes(mutate((g) => (g.nodes.check.onFalse = 'ghost'))).includes('EDGE_TARGET_UNKNOWN'),
    );
  });

  it('cycles are rejected (v1 graphs are acyclic)', () => {
    assert.ok(codes(mutate((g) => (g.nodes.tag.next = 'pause'))).includes('CYCLE'));
  });

  it('unreachable nodes and graphs without a reachable exit', () => {
    assert.deepEqual(codes(mutate((g) => (g.nodes.orphan = { type: 'exit' }))), [
      'UNREACHABLE_NODE',
    ]);
    const noExit = {
      schemaVersion: 1,
      entry: 'a',
      nodes: {
        a: { type: 'entry', trigger: { kind: 'api' }, next: 'b' },
        b: { type: 'wait_duration', seconds: 60, next: 'b' },
      },
    };
    assert.ok(codes(noExit).includes('NO_EXIT'));
  });

  it('node keys and unknown node types', () => {
    const g = mutate((x) => {
      x.nodes.Bad = { type: 'exit' };
      x.nodes.tag.next = 'Bad';
    });
    assert.ok(codes(g).includes('NODE_KEY_INVALID'));
    assert.ok(
      codes(mutate((g) => (g.nodes.done = { type: 'teleport' }))).includes('NODE_TYPE_UNKNOWN'),
    );
  });

  it('send references must name a send node on every path', () => {
    assert.ok(
      codes(mutate((g) => (g.nodes.wait.sendNodeKey = 'pause'))).includes('SEND_REFERENCE_INVALID'),
    );
    // A send node on only one branch does not dominate the join.
    const g = {
      schemaVersion: 1,
      entry: 's',
      nodes: {
        s: { type: 'entry', trigger: { kind: 'api' }, next: 'c' },
        c: {
          type: 'condition',
          rule: { kind: 'tag', tag: 'vip', present: true },
          onTrue: 'm',
          onFalse: 'j',
        },
        m: {
          type: 'send_message',
          channel: 'sms',
          templateId: T,
          variables: {},
          onSuppressed: 'continue',
          onRefused: 'exit',
          next: 'j',
        },
        j: {
          type: 'wait_for_outcome',
          sendNodeKey: 'm',
          outcome: 'delivered',
          timeoutSeconds: 600,
          onOutcome: 'x',
          onTimeout: 'x',
        },
        x: { type: 'exit' },
      },
    };
    assert.deepEqual(codes(g), ['SEND_REFERENCE_INVALID']);
    (g.nodes.c as any).onFalse = 'm';
    assert.deepEqual(codes(g), []);
  });

  it('field validation per node type', () => {
    const cases: [string, (g: any) => void][] = [
      ['trigger.event', (g) => (g.nodes.start.trigger.event = 'order.placed')],
      [
        'trigger.tag',
        (g) => (g.nodes.start.trigger = { kind: 'event', event: 'contact.tag_added' }),
      ],
      [
        'trigger.schedule.time',
        (g) =>
          (g.nodes.start.trigger = {
            kind: 'schedule',
            segmentId: S,
            schedule: { type: 'recurring', frequency: 'daily', time: '25:00', timeZone: 'UTC' },
          }),
      ],
      [
        'trigger.schedule.daysOfWeek',
        (g) =>
          (g.nodes.start.trigger = {
            kind: 'schedule',
            segmentId: S,
            schedule: { type: 'recurring', frequency: 'weekly', time: '10:00', timeZone: 'UTC' },
          }),
      ],
      [
        'trigger.schedule.timeZone',
        (g) =>
          (g.nodes.start.trigger = {
            kind: 'schedule',
            segmentId: S,
            schedule: {
              type: 'recurring',
              frequency: 'daily',
              time: '10:00',
              timeZone: 'Mars/Base',
            },
          }),
      ],
      [
        'trigger.schedule.at',
        (g) =>
          (g.nodes.start.trigger = {
            kind: 'schedule',
            segmentId: S,
            schedule: { type: 'once', at: 'tomorrow' },
          }),
      ],
      ['channel', (g) => (g.nodes.welcome.channel = 'email')],
      ['templateId', (g) => (g.nodes.welcome.templateId = 'abc')],
      [
        'variables.name',
        (g) => (g.nodes.welcome.variables.name = { source: 'contact_field', field: 'password' }),
      ],
      ['onRefused', (g) => (g.nodes.welcome.onRefused = 'retry')],
      ['seconds', (g) => (g.nodes.pause.seconds = 30)],
      ['seconds', (g) => (g.nodes.pause.seconds = 1.5)],
      ['endTime', (g) => (g.nodes.window.endTime = '09:00')],
      ['timeZone', (g) => (g.nodes.window.timeZone = 'Nowhere')],
      ['daysOfWeek', (g) => (g.nodes.window.daysOfWeek = [1, 1])],
      ['rule.outcome', (g) => (g.nodes.check.rule.outcome = 'opened')],
      [
        'rule.field',
        (g) => (g.nodes.check.rule = { kind: 'attribute', field: 'email', op: 'exists' }),
      ],
      [
        'rule.value',
        (g) => (g.nodes.check.rule = { kind: 'attribute', field: 'firstName', op: 'eq' }),
      ],
      [
        'rule.value',
        (g) =>
          (g.nodes.check.rule = {
            kind: 'attribute',
            field: 'firstName',
            op: 'exists',
            value: 'x',
          }),
      ],
      ['rule.kind', (g) => (g.nodes.check.rule = { kind: 'random' })],
      ['timeoutSeconds', (g) => (g.nodes.wait.timeoutSeconds = 10)],
      ['operations', (g) => (g.nodes.tag.operations = [])],
      ['operations.0.op', (g) => (g.nodes.tag.operations = [{ op: 'delete_contact' }])],
      ['operations.1.field', (g) => (g.nodes.tag.operations[1].field = 'custom.')],
      ['label', (g) => (g.nodes.hook.label = '')],
    ];
    for (const [path, fn] of cases) {
      const r = validateJourneyGraph(mutate(fn));
      assert.ok(
        r.errors.some((e) => e.code === 'FIELD_INVALID' && e.path === path),
        `${path}: ${JSON.stringify(r.errors)}`,
      );
    }
  });

  it('canonical JSON ignores key order and undefined members', () => {
    assert.equal(
      canonicalJourneyJson({ b: 1, a: [{ d: 2, c: 3 }] }),
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
    assert.equal(canonicalJourneyJson({ a: 1, b: undefined }), canonicalJourneyJson({ a: 1 }));
  });

  it('time zones are checked with Intl only', () => {
    assert.equal(isJourneyTimeZone('Asia/Kolkata'), true);
    assert.equal(isJourneyTimeZone('UTC'), true);
    assert.equal(isJourneyTimeZone('Not/AZone'), false);
    assert.equal(isJourneyTimeZone(''), false);
  });
});
