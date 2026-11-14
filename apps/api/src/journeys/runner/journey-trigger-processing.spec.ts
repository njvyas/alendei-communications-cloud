import {
  JourneyTriggerProcessingService,
  type ScheduleClaim,
} from './journey-trigger-processing.service';

describe('Phase 8C PR 8C-4 — scheduled next fire', () => {
  const claim = (schedule: ScheduleClaim['schedule'], firingAt: string): ScheduleClaim => ({
    triggerId: 't',
    orgId: 'o',
    workspaceId: 'w',
    journeyId: 'j',
    journeyVersionId: 'v',
    segmentId: 's',
    schedule,
    firingAt: new Date(firingAt),
    fireCursor: null,
    claimToken: 'c',
    epoch: 1,
    attempts: 1,
  });
  const at = (now: string) =>
    new JourneyTriggerProcessingService(null, { now: () => new Date(now) });
  const daily = {
    type: 'recurring',
    frequency: 'daily',
    time: '09:00',
    timeZone: 'Asia/Kolkata',
  } as const;

  it('is strictly after the fire instant', () => {
    expect(at('2030-03-10T03:30:05Z').nextFireAfter(claim(daily, '2030-03-10T03:30:00Z'))).toEqual(
      new Date('2030-03-11T03:30:00Z'),
    );
  });

  it('missed fires are not replayed: the next fire is computed from now', () => {
    expect(at('2030-03-13T12:00:00Z').nextFireAfter(claim(daily, '2030-03-10T03:30:00Z'))).toEqual(
      new Date('2030-03-14T03:30:00Z'),
    );
  });

  it('a one-off schedule never recurs, even when its instant is still ahead of a skewed clock', () => {
    const once = { type: 'once', at: '2099-01-01T00:00:00Z' } as const;
    expect(
      at('2030-01-01T00:00:00Z').nextFireAfter(claim(once, '2030-01-01T00:00:00Z')),
    ).toBeNull();
  });

  it('DST fall-back: the repeated 01:30 is not a second fire', () => {
    const ny = {
      type: 'recurring',
      frequency: 'daily',
      time: '01:30',
      timeZone: 'America/New_York',
    } as const;
    expect(at('2026-11-01T05:31:00Z').nextFireAfter(claim(ny, '2026-11-01T05:30:00Z'))).toEqual(
      new Date('2026-11-02T06:30:00Z'),
    );
  });

  it('is disabled without a journey database', async () => {
    const svc = new JourneyTriggerProcessingService(null);
    expect(svc.available).toBe(false);
    await expect(svc.processEvents()).rejects.toThrow(/disabled/);
    await expect(svc.claimSchedule()).rejects.toThrow(/disabled/);
  });
});
