import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY_RUNNER_LIMITS, nextJourneyWindowStart } from '../src/journeys';

/** Phase 8C PR 8C-3 — wait_window computation and the runner bounds. */

const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('wait_window next start (8C-3)', () => {
  const office = { startTime: '09:00', endTime: '17:00', timeZone: 'Asia/Kolkata' } as const;

  it('inside the window: null (proceed now); before it: today’s start; after it: tomorrow’s', () => {
    // 10:00 IST = 04:30Z
    assert.equal(nextJourneyWindowStart(office, new Date('2030-03-12T04:30:00Z')), null);
    // 08:00 IST = 02:30Z → 09:00 IST = 03:30Z
    assert.equal(
      iso(nextJourneyWindowStart(office, new Date('2030-03-12T02:30:00Z'))),
      '2030-03-12T03:30:00.000Z',
    );
    // 17:00 IST exactly is outside (end exclusive) → next day 09:00 IST
    assert.equal(
      iso(nextJourneyWindowStart(office, new Date('2030-03-12T11:30:00Z'))),
      '2030-03-13T03:30:00.000Z',
    );
  });

  it('respects ISO days of week (Friday evening → Monday morning)', () => {
    const weekdays = { ...office, daysOfWeek: [1, 2, 3, 4, 5] };
    // 2030-03-15 is a Friday; 18:00 IST = 12:30Z → Monday 2030-03-18 09:00 IST
    assert.equal(
      iso(nextJourneyWindowStart(weekdays, new Date('2030-03-15T12:30:00Z'))),
      '2030-03-18T03:30:00.000Z',
    );
  });

  it('a window crossing midnight belongs to the day it opens on', () => {
    const night = {
      startTime: '22:00',
      endTime: '02:00',
      daysOfWeek: [6],
      timeZone: 'UTC',
    } as const;
    // 2030-03-16 is a Saturday: 23:00 Saturday is inside; 01:00 Sunday still inside (opened Saturday)
    assert.equal(nextJourneyWindowStart(night, new Date('2030-03-16T23:00:00Z')), null);
    assert.equal(nextJourneyWindowStart(night, new Date('2030-03-17T01:00:00Z')), null);
    // 03:00 Sunday: closed; next opening is the following Saturday 22:00
    assert.equal(
      iso(nextJourneyWindowStart(night, new Date('2030-03-17T03:00:00Z'))),
      '2030-03-23T22:00:00.000Z',
    );
  });

  it('DST: a window opening inside a spring-forward gap opens at the first valid instant', () => {
    const early = { startTime: '02:30', endTime: '04:00', timeZone: 'America/New_York' } as const;
    // 08-Mar-2026 01:00 EST = 06:00Z; 02:30 does not exist → 03:30 EDT = 07:30Z
    assert.equal(
      iso(nextJourneyWindowStart(early, new Date('2026-03-08T06:00:00Z'))),
      '2026-03-08T07:30:00.000Z',
    );
  });
});

describe('runner bounds (handover §§8.2, 9)', () => {
  it('are the handover defaults', () => {
    assert.deepEqual(
      { ...JOURNEY_RUNNER_LIMITS },
      {
        transientMaxAttempts: 3,
        poisonClaims: 5,
        maxTransitionsPerClaim: 25,
        backoffBaseMs: 1000,
        backoffMaxMs: 60000,
        maxTransitions: 1000,
      },
    );
  });
});
