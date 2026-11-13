import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNEY_LIFECYCLE_ACTIONS,
  JOURNEY_STATUSES,
  defaultJourneyGraph,
  deriveJourneyTrigger,
  journeyGraphHasSendNode,
  journeyLifecycleTarget,
  nextJourneyScheduleFire,
  validateJourneyGraph,
  zonedWallTimeToInstant,
  type JourneyGraph,
} from '../src/journeys';

/** Phase 8C PR 8C-2 — lifecycle state machine, trigger derivation, schedule next-fire. */

const S = '0193f000-0000-7000-8000-000000000002';
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function withEntry(trigger: unknown): JourneyGraph {
  return {
    schemaVersion: 1,
    entry: 'start',
    nodes: {
      start: { type: 'entry', trigger, next: 'done' } as never,
      done: { type: 'exit' },
    },
  };
}

describe('journey lifecycle state machine (8C-2)', () => {
  it('admits exactly the handover §8.5 transitions; same-state is a no-op; archived is terminal', () => {
    const table: Record<string, Record<string, string | null>> = {};
    for (const action of JOURNEY_LIFECYCLE_ACTIONS) {
      table[action] = {};
      for (const from of JOURNEY_STATUSES)
        table[action]![from] = journeyLifecycleTarget(action, from);
    }
    assert.deepEqual(table, {
      activate: { draft: 'active', active: 'active', paused: null, archived: null },
      pause: { draft: null, active: 'paused', paused: 'paused', archived: null },
      resume: { draft: null, active: 'active', paused: 'active', archived: null },
      archive: { draft: 'archived', active: 'archived', paused: 'archived', archived: 'archived' },
    });
    // Nothing leaves `archived`, and nothing returns to `draft`.
    for (const action of JOURNEY_LIFECYCLE_ACTIONS) {
      assert.ok([null, 'archived'].includes(journeyLifecycleTarget(action, 'archived')));
      for (const from of JOURNEY_STATUSES)
        assert.notEqual(journeyLifecycleTarget(action, from), 'draft');
    }
  });
});

describe('trigger derivation (8C-2)', () => {
  it('api, event (with and without tag) and schedule', () => {
    assert.deepEqual(deriveJourneyTrigger(defaultJourneyGraph()), {
      kind: 'api',
      eventKind: null,
      eventTag: null,
      segmentId: null,
      schedule: null,
    });
    assert.deepEqual(
      deriveJourneyTrigger(withEntry({ kind: 'event', event: 'contact.tag_added', tag: 'vip' })),
      {
        kind: 'event',
        eventKind: 'contact.tag_added',
        eventTag: 'vip',
        segmentId: null,
        schedule: null,
      },
    );
    assert.deepEqual(deriveJourneyTrigger(withEntry({ kind: 'event', event: 'message.read' })), {
      kind: 'event',
      eventKind: 'message.read',
      eventTag: null,
      segmentId: null,
      schedule: null,
    });
    const schedule = { type: 'once', at: '2030-01-01T00:00:00Z' } as const;
    assert.deepEqual(
      deriveJourneyTrigger(withEntry({ kind: 'schedule', segmentId: S, schedule })),
      {
        kind: 'schedule',
        eventKind: null,
        eventTag: null,
        segmentId: S,
        schedule,
      },
    );
  });

  it('throws on a graph without an entry node, including an inherited name', () => {
    assert.throws(() =>
      deriveJourneyTrigger({ schemaVersion: 1, entry: 'nope', nodes: {} } as JourneyGraph),
    );
    assert.throws(() =>
      deriveJourneyTrigger({ schemaVersion: 1, entry: 'constructor', nodes: {} } as JourneyGraph),
    );
  });

  it('detects send nodes (activation is refused while sends are disabled)', () => {
    assert.equal(journeyGraphHasSendNode(defaultJourneyGraph()), false);
    const g = defaultJourneyGraph() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    g.nodes.start.next = 'send';
    g.nodes.send = {
      type: 'send_message',
      channel: 'sms',
      templateId: S,
      variables: {},
      onSuppressed: 'continue',
      onRefused: 'exit',
      next: 'finish',
    };
    assert.equal(validateJourneyGraph(g).valid, true);
    assert.equal(journeyGraphHasSendNode(g), true);
  });
});

describe('schedule next-fire computation (8C-2; time zones and DST)', () => {
  it('once: the instant if still in the future, otherwise null', () => {
    const at = '2030-06-01T10:00:00+05:30';
    assert.equal(
      iso(nextJourneyScheduleFire({ type: 'once', at }, new Date('2030-06-01T04:29:59Z'))),
      '2030-06-01T04:30:00.000Z',
    );
    assert.equal(
      nextJourneyScheduleFire({ type: 'once', at }, new Date('2030-06-01T04:30:00Z')),
      null,
    );
  });

  it('daily in Asia/Kolkata (+05:30, no DST): today if still ahead, else tomorrow', () => {
    const s = {
      type: 'recurring',
      frequency: 'daily',
      time: '09:00',
      timeZone: 'Asia/Kolkata',
    } as const;
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2030-03-10T03:00:00Z'))),
      '2030-03-10T03:30:00.000Z',
    );
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2030-03-10T03:30:00Z'))),
      '2030-03-11T03:30:00.000Z',
    );
    // Late evening UTC is already the next local day in Kolkata.
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2030-03-10T20:00:00Z'))),
      '2030-03-11T03:30:00.000Z',
    );
  });

  it('weekly picks the next listed ISO weekday (1 = Monday, 7 = Sunday)', () => {
    const s = {
      type: 'recurring',
      frequency: 'weekly',
      time: '18:00',
      daysOfWeek: [1, 7],
      timeZone: 'UTC',
    } as const;
    // 2030-03-13 is a Wednesday.
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2030-03-13T12:00:00Z'))),
      '2030-03-17T18:00:00.000Z',
    );
    // Sunday after 18:00 → Monday.
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2030-03-17T18:00:00Z'))),
      '2030-03-18T18:00:00.000Z',
    );
  });

  it('DST gap (America/New_York, 08-Mar-2026): 02:30 does not exist and runs at 03:30 EDT', () => {
    assert.equal(
      new Date(zonedWallTimeToInstant(2026, 3, 8, 2, 30, 'America/New_York')).toISOString(),
      '2026-03-08T07:30:00.000Z',
    );
    const s = {
      type: 'recurring',
      frequency: 'daily',
      time: '02:30',
      timeZone: 'America/New_York',
    } as const;
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2026-03-08T05:00:00Z'))),
      '2026-03-08T07:30:00.000Z',
    );
    // The day after, 02:30 EDT exists again (UTC−4).
    assert.equal(
      iso(nextJourneyScheduleFire(s, new Date('2026-03-08T07:30:00Z'))),
      '2026-03-09T06:30:00.000Z',
    );
  });

  it('DST overlap (America/New_York, 01-Nov-2026): 01:30 occurs twice and runs at the first', () => {
    assert.equal(
      new Date(zonedWallTimeToInstant(2026, 11, 1, 1, 30, 'America/New_York')).toISOString(),
      '2026-11-01T05:30:00.000Z',
    );
    // Europe/London autumn overlap: 01:30 BST (00:30Z) before 01:30 GMT (01:30Z).
    assert.equal(
      new Date(zonedWallTimeToInstant(2026, 10, 25, 1, 30, 'Europe/London')).toISOString(),
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('southern-hemisphere DST (Australia/Sydney, 04-Oct-2026 gap at 02:00)', () => {
    assert.equal(
      new Date(zonedWallTimeToInstant(2026, 10, 4, 2, 15, 'Australia/Sydney')).toISOString(),
      // 02:15 AEST does not exist; 03:15 AEDT (UTC+11) = 16:15Z the previous day.
      '2026-10-03T16:15:00.000Z',
    );
  });
});
