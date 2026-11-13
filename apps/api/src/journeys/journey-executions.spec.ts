import { defaultJourneyGraph, type JourneyGraph } from '@acc/contracts';

import { apiEntryRef, journeyNodeOrder } from './journey-executions.service';

describe('Phase 8C PR 8C-2 — execution helpers', () => {
  it('journeyNodeOrder walks breadth-first from the entry along edges in catalogue order', () => {
    const graph = {
      schemaVersion: 1,
      entry: 'start',
      nodes: {
        zeta: { type: 'exit' },
        branch: {
          type: 'condition',
          rule: { kind: 'tag', tag: 'vip', present: true },
          onTrue: 'zeta',
          onFalse: 'alpha',
        },
        alpha: { type: 'wait_duration', seconds: 60, next: 'zeta' },
        start: { type: 'entry', trigger: { kind: 'api' }, next: 'branch' },
        orphan: { type: 'exit' },
      },
    } as unknown as JourneyGraph;
    expect(journeyNodeOrder(graph)).toEqual(['start', 'branch', 'zeta', 'alpha', 'orphan']);
    expect(journeyNodeOrder(defaultJourneyGraph())).toEqual(['start', 'finish']);
  });

  it('journeyNodeOrder ignores inherited names as entry or edge targets', () => {
    const graph = {
      schemaVersion: 1,
      entry: 'constructor',
      nodes: { a: { type: 'exit' } },
    } as unknown as JourneyGraph;
    expect(journeyNodeOrder(graph)).toEqual(['a']);
  });

  it('apiEntryRef is stable per organisation, journey and key, and never contains the key', () => {
    const a = apiEntryRef('org-1', 'journey-1', 'the-key');
    expect(a).toMatch(/^api:[0-9a-f]{64}$/);
    expect(a).not.toContain('the-key');
    expect(apiEntryRef('org-1', 'journey-1', 'the-key')).toBe(a);
    expect(apiEntryRef('org-2', 'journey-1', 'the-key')).not.toBe(a);
    expect(apiEntryRef('org-1', 'journey-2', 'the-key')).not.toBe(a);
    expect(apiEntryRef('org-1', 'journey-1', 'other-key')).not.toBe(a);
  });
});
