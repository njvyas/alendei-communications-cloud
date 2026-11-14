'use client';

import { useContext, useMemo, useState } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { segmentsApi } from '@/lib/api-client';
import { useCanReadContacts } from '@/lib/session-store';
import {
  JOURNEY_CHANNELS,
  JOURNEY_TRIGGER_EVENTS,
  formatWaitSeconds,
  getNodeDisplayLabel,
  getNodeTypeLabel,
  isJourneyTimeZone,
  isJourneyUuid,
  nextJourneyScheduleFire,
  type JourneyChannel,
  type JourneyGraph,
  type JourneyNode,
  type JourneySchedule,
  type JourneyTriggerEvent,
} from '@/lib/journeys';
import { JourneyNodeIcon, getNodeTypeColorClass } from './journey-node-icon';

export interface JourneyNodeInspectorProps {
  readonly nodeKey: string;
  readonly node: JourneyNode;
  readonly graph: JourneyGraph;
  readonly workspaceId?: string;
  readonly readOnly?: boolean;
  readonly onChange: (updatedNode: JourneyNode) => void;
  readonly onDelete?: (nodeKey: string) => void;
  readonly onClose: () => void;
}

const COMMON_TIME_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

const DAYS_OF_WEEK_LABELS = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 7, label: 'Sun' },
];

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function toDatetimeLocal(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function fromDatetimeLocal(localStr: string): string {
  try {
    const d = new Date(localStr);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  } catch {
    return '';
  }
}

function SegmentSelectControl({
  workspaceId,
  selectedSegmentId,
  readOnly,
  onSelect,
}: {
  workspaceId: string;
  selectedSegmentId: string;
  readOnly?: boolean;
  onSelect: (id: string) => void;
}) {
  const { data: segmentsData } = useQuery({
    queryKey: ['segments', workspaceId],
    queryFn: () => segmentsApi.list(workspaceId),
  });
  const segments = segmentsData?.data ?? [];

  return (
    <select
      id="trigger-segment-select"
      aria-label="Audience Segment"
      disabled={readOnly}
      value={selectedSegmentId}
      onChange={(e) => onSelect(e.target.value)}
      className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
    >
      <option value="">Select a segment…</option>
      {segments.map((seg) => (
        <option key={seg.id} value={seg.id}>
          {seg.name} ({seg.id.slice(0, 8)}…)
        </option>
      ))}
    </select>
  );
}

export function JourneyNodeInspector({
  nodeKey,
  node,
  graph,
  workspaceId,
  readOnly = false,
  onChange,
  onDelete,
  onClose,
}: JourneyNodeInspectorProps) {
  const isEntry = nodeKey === graph.entry;
  // Edges may not target self or the entry node
  const candidateTargets = Object.keys(graph.nodes).filter(
    (k) => k !== nodeKey && k !== graph.entry,
  );

  const queryClient = useContext(QueryClientContext);
  const canReadContacts = useCanReadContacts();
  const [manualSegmentEntry, setManualSegmentEntry] = useState(false);
  const [customTimeZoneInput, setCustomTimeZoneInput] = useState(false);

  const defaultTz = useMemo(() => {
    try {
      const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return isJourneyTimeZone(resolved) ? resolved : 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);

  const nextFire = useMemo(() => {
    if (node.type !== 'entry' || node.trigger.kind !== 'schedule') return null;
    try {
      return nextJourneyScheduleFire(node.trigger.schedule, new Date());
    } catch {
      return null;
    }
  }, [node]);

  const updateSchedule = (partial: { segmentId?: string; schedule?: JourneySchedule }) => {
    if (node.type !== 'entry' || node.trigger.kind !== 'schedule') return;
    onChange({
      ...node,
      trigger: {
        kind: 'schedule',
        segmentId: partial.segmentId !== undefined ? partial.segmentId : node.trigger.segmentId,
        schedule: partial.schedule !== undefined ? partial.schedule : node.trigger.schedule,
      },
    });
  };

  return (
    <aside
      aria-label="Node Inspector"
      className="flex h-full w-80 md:w-96 flex-col border-l border-acc-border bg-acc-surface text-acc-text-primary shadow-lg"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-acc-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`rounded-lg border p-1.5 ${getNodeTypeColorClass(node.type)}`}>
            <JourneyNodeIcon type={node.type} className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-sm font-semibold leading-tight">{getNodeTypeLabel(node.type)}</h3>
            <p className="font-mono text-[11px] text-acc-text-secondary">{nodeKey}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
          aria-label="Close inspector"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Body / Scrollable Controls */}
      <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
        {/* Placeholder label edit */}
        {'label' in node && (
          <div>
            <label
              htmlFor="node-label-input"
              className="block font-semibold text-acc-text-secondary"
            >
              Label
            </label>
            <input
              id="node-label-input"
              type="text"
              disabled={readOnly}
              value={node.label || ''}
              onChange={(e) => onChange({ ...node, label: e.target.value })}
              className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs text-acc-text-primary focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
            />
          </div>
        )}

        {/* --- Entry Node Config --- */}
        {node.type === 'entry' && (
          <div className="space-y-4 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3.5">
            <div className="flex items-center justify-between border-b border-acc-border/60 pb-2">
              <h4 className="font-semibold text-acc-text-primary">Trigger Configuration</h4>
              <span className="rounded bg-acc-surface px-1.5 py-0.5 font-mono text-[10px] uppercase text-acc-text-secondary border border-acc-border">
                {node.trigger.kind}
              </span>
            </div>

            <div>
              <label
                htmlFor="trigger-kind-select"
                className="block text-acc-text-secondary font-medium"
              >
                Trigger Kind
              </label>
              <select
                id="trigger-kind-select"
                disabled={readOnly}
                value={node.trigger.kind}
                onChange={(e) => {
                  const kind = e.target.value as 'api' | 'event' | 'schedule';
                  if (kind === 'api') {
                    onChange({ ...node, trigger: { kind: 'api' } });
                  } else if (kind === 'event') {
                    onChange({
                      ...node,
                      trigger: { kind: 'event', event: 'contact.created' },
                    });
                  } else {
                    onChange({
                      ...node,
                      trigger: {
                        kind: 'schedule',
                        segmentId: '',
                        schedule: {
                          type: 'recurring',
                          frequency: 'daily',
                          time: '09:00',
                          timeZone: defaultTz,
                        },
                      },
                    });
                  }
                }}
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              >
                <option value="api">Inbound API (Manual / API Enrolment)</option>
                <option value="event">Platform Event Intake</option>
                <option value="schedule">Scheduled Segment Dispatch</option>
              </select>
            </div>

            {/* Inbound API Information */}
            {node.trigger.kind === 'api' && (
              <div className="rounded-md border border-sky-500/20 bg-sky-500/10 p-2.5 text-[11px] text-sky-300">
                <p className="font-medium">Inbound API Enrolment</p>
                <p className="mt-1 text-sky-200/80">
                  Contacts enter this journey via API calls (<code>POST /enrollments</code>) or
                  direct operator enrolment in the detail view.
                </p>
              </div>
            )}

            {/* Platform Event Config */}
            {node.trigger.kind === 'event' && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="trigger-event-select"
                    className="block text-acc-text-secondary font-medium"
                  >
                    Platform Event Type
                  </label>
                  <select
                    id="trigger-event-select"
                    disabled={readOnly}
                    value={node.trigger.event}
                    onChange={(e) => {
                      const nextEvent = e.target.value as JourneyTriggerEvent;
                      if (nextEvent === 'contact.tag_added') {
                        onChange({
                          ...node,
                          trigger: {
                            kind: 'event',
                            event: 'contact.tag_added',
                            tag:
                              node.trigger.kind === 'event' && node.trigger.tag
                                ? node.trigger.tag
                                : '',
                          },
                        });
                      } else {
                        // Strict contract rule: tag is only permitted on contact.tag_added
                        onChange({
                          ...node,
                          trigger: {
                            kind: 'event',
                            event: nextEvent,
                          },
                        });
                      }
                    }}
                    className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                  >
                    {JOURNEY_TRIGGER_EVENTS.map((ev) => (
                      <option key={ev} value={ev}>
                        {ev}
                      </option>
                    ))}
                  </select>
                </div>

                {node.trigger.event === 'contact.tag_added' && (
                  <div>
                    <div className="flex items-center justify-between">
                      <label
                        htmlFor="trigger-tag-input"
                        className="block text-acc-text-secondary font-medium"
                      >
                        Tag Name <span className="text-red-400">*</span>
                      </label>
                      <span className="text-[10px] text-acc-text-tertiary">
                        {(node.trigger.tag || '').length}/64
                      </span>
                    </div>
                    <input
                      id="trigger-tag-input"
                      type="text"
                      disabled={readOnly}
                      maxLength={64}
                      value={node.trigger.tag || ''}
                      onChange={(e) =>
                        onChange({
                          ...node,
                          trigger: {
                            kind: 'event',
                            event: 'contact.tag_added',
                            tag: e.target.value,
                          },
                        })
                      }
                      placeholder="e.g. VIP, lead_verified"
                      className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                    />
                    {!node.trigger.tag || node.trigger.tag.trim().length === 0 ? (
                      <p className="mt-1 text-[11px] text-amber-400">
                        Tag is required for contact.tag_added events.
                      </p>
                    ) : node.trigger.tag.length > 64 ? (
                      <p className="mt-1 text-[11px] text-red-400">
                        Tag length cannot exceed 64 characters.
                      </p>
                    ) : (
                      <p className="mt-1 text-[10px] text-acc-text-tertiary">
                        Contacts receiving this tag will be enrolled automatically once activated.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Scheduled Trigger Config */}
            {node.trigger.kind === 'schedule' && (
              <div className="space-y-3.5">
                {/* Segment Selector with RBAC boundary */}
                <div>
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="trigger-segment-input"
                      className="block text-acc-text-secondary font-medium"
                    >
                      Audience Segment <span className="text-red-400">*</span>
                    </label>
                    {canReadContacts && workspaceId && queryClient && (
                      <button
                        type="button"
                        onClick={() => setManualSegmentEntry(!manualSegmentEntry)}
                        className="text-[10px] text-acc-accent hover:underline focus:outline-hidden"
                      >
                        {manualSegmentEntry ? 'Pick from saved segments' : 'Enter UUID manually'}
                      </button>
                    )}
                  </div>

                  {canReadContacts && workspaceId && queryClient && !manualSegmentEntry ? (
                    <SegmentSelectControl
                      workspaceId={workspaceId}
                      selectedSegmentId={node.trigger.segmentId}
                      readOnly={readOnly}
                      onSelect={(segId) => updateSchedule({ segmentId: segId })}
                    />
                  ) : (
                    <input
                      id="trigger-segment-input"
                      aria-label="Audience Segment UUID"
                      type="text"
                      disabled={readOnly}
                      value={node.trigger.segmentId}
                      onChange={(e) => updateSchedule({ segmentId: e.target.value.trim() })}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      className="mt-1 block w-full font-mono rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                    />
                  )}

                  {!canReadContacts && (
                    <p className="mt-1 text-[10px] text-acc-text-tertiary">
                      Note: Segment list requires <code>contacts.read</code> permission. Enter the
                      Segment UUID manually.
                    </p>
                  )}

                  {!node.trigger.segmentId ? (
                    <p className="mt-1 text-[11px] text-red-400">
                      Audience segment selection or UUID is required.
                    </p>
                  ) : !isJourneyUuid(node.trigger.segmentId) ? (
                    <p className="mt-1 text-[11px] text-red-400">
                      Segment ID must be a valid UUID.
                    </p>
                  ) : null}
                </div>

                {/* Schedule Type Selection */}
                <div>
                  <label className="block text-acc-text-secondary font-medium">Schedule Type</label>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        updateSchedule({
                          schedule: {
                            type: 'recurring',
                            frequency: 'daily',
                            time: '09:00',
                            timeZone: defaultTz,
                          },
                        })
                      }
                      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        node.trigger.schedule.type === 'recurring'
                          ? 'border-acc-accent bg-acc-accent/10 text-acc-accent'
                          : 'border-acc-border bg-acc-surface-raised text-acc-text-secondary hover:text-acc-text-primary'
                      }`}
                    >
                      Recurring
                    </button>
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={() =>
                        updateSchedule({
                          schedule: {
                            type: 'once',
                            at: new Date(Date.now() + 86400000).toISOString(),
                          },
                        })
                      }
                      className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        node.trigger.schedule.type === 'once'
                          ? 'border-acc-accent bg-acc-accent/10 text-acc-accent'
                          : 'border-acc-border bg-acc-surface-raised text-acc-text-secondary hover:text-acc-text-primary'
                      }`}
                    >
                      One-Time
                    </button>
                  </div>
                </div>

                {/* Once Schedule Details */}
                {node.trigger.schedule.type === 'once' && (
                  <div className="space-y-2 rounded-md border border-acc-border/60 bg-acc-surface/50 p-2.5">
                    <label
                      htmlFor="trigger-schedule-at"
                      className="block text-acc-text-secondary font-medium"
                    >
                      Execution Date & Time (Browser Local Time)
                    </label>
                    <input
                      id="trigger-schedule-at"
                      type="datetime-local"
                      disabled={readOnly}
                      value={toDatetimeLocal(node.trigger.schedule.at)}
                      onChange={(e) => {
                        const iso = fromDatetimeLocal(e.target.value);
                        if (iso) {
                          updateSchedule({
                            schedule: {
                              type: 'once',
                              at: iso,
                            },
                          });
                        }
                      }}
                      className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs font-mono focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                    />
                    {Date.parse(node.trigger.schedule.at) <= Date.now() ? (
                      <p className="text-[11px] text-red-400">
                        Schedule fire time must be in the future.
                      </p>
                    ) : Date.parse(node.trigger.schedule.at) > Date.now() + 366 * 86400000 ? (
                      <p className="text-[11px] text-red-400">
                        Schedule fire time exceeds maximum lookahead limit (366 days).
                      </p>
                    ) : (
                      <p className="text-[10px] text-acc-text-tertiary">
                        Interpreted in your browser's local time ({defaultTz}) and saved as UTC
                        instant: {node.trigger.schedule.at}
                      </p>
                    )}
                  </div>
                )}

                {/* Recurring Schedule Details */}
                {node.trigger.schedule.type === 'recurring' && (
                  <div className="space-y-3 rounded-md border border-acc-border/60 bg-acc-surface/50 p-2.5">
                    {/* Frequency */}
                    <div>
                      <label
                        htmlFor="trigger-schedule-frequency"
                        className="block text-acc-text-secondary font-medium"
                      >
                        Recurrence Frequency
                      </label>
                      <select
                        id="trigger-schedule-frequency"
                        disabled={readOnly}
                        value={node.trigger.schedule.frequency}
                        onChange={(e) => {
                          const freq = e.target.value as 'daily' | 'weekly';
                          if (
                            node.trigger.kind === 'schedule' &&
                            node.trigger.schedule.type === 'recurring'
                          ) {
                            if (freq === 'daily') {
                              // Strict contract requirement: daysOfWeek MUST be undefined for daily
                              updateSchedule({
                                schedule: {
                                  type: 'recurring',
                                  frequency: 'daily',
                                  time: node.trigger.schedule.time,
                                  timeZone: node.trigger.schedule.timeZone,
                                  daysOfWeek: undefined,
                                },
                              });
                            } else {
                              updateSchedule({
                                schedule: {
                                  type: 'recurring',
                                  frequency: 'weekly',
                                  time: node.trigger.schedule.time,
                                  timeZone: node.trigger.schedule.timeZone,
                                  daysOfWeek: [1], // Default Monday
                                },
                              });
                            }
                          }
                        }}
                        className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                      >
                        <option value="daily">Daily (Every Day)</option>
                        <option value="weekly">Weekly (Selected Days)</option>
                      </select>
                    </div>

                    {/* Weekly Days Picker */}
                    {node.trigger.schedule.frequency === 'weekly' && (
                      <div>
                        <label className="block text-acc-text-secondary font-medium mb-1">
                          Days of Week (1=Mon … 7=Sun)
                        </label>
                        <div className="flex flex-wrap gap-1">
                          {DAYS_OF_WEEK_LABELS.map(({ day, label }) => {
                            const selectedDays =
                              node.trigger.kind === 'schedule' &&
                              node.trigger.schedule.type === 'recurring' &&
                              node.trigger.schedule.frequency === 'weekly'
                                ? (node.trigger.schedule.daysOfWeek ?? [])
                                : [];
                            const isSelected = selectedDays.includes(day);

                            return (
                              <button
                                key={day}
                                type="button"
                                disabled={readOnly}
                                aria-pressed={isSelected}
                                onClick={() => {
                                  if (
                                    node.trigger.kind === 'schedule' &&
                                    node.trigger.schedule.type === 'recurring' &&
                                    node.trigger.schedule.frequency === 'weekly'
                                  ) {
                                    const nextDays = isSelected
                                      ? selectedDays.filter((d) => d !== day)
                                      : [...selectedDays, day].sort((a, b) => a - b);
                                    updateSchedule({
                                      schedule: {
                                        type: 'recurring',
                                        frequency: 'weekly',
                                        time: node.trigger.schedule.time,
                                        timeZone: node.trigger.schedule.timeZone,
                                        daysOfWeek: nextDays,
                                      },
                                    });
                                  }
                                }}
                                className={`rounded px-2 py-1 text-xs font-mono font-medium transition-colors ${
                                  isSelected
                                    ? 'bg-acc-accent text-white'
                                    : 'border border-acc-border bg-acc-surface-raised text-acc-text-secondary hover:text-acc-text-primary'
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        {(!node.trigger.schedule.daysOfWeek ||
                          node.trigger.schedule.daysOfWeek.length === 0) && (
                          <p className="mt-1 text-[11px] text-red-400">
                            Weekly schedules require at least one selected day (1–7).
                          </p>
                        )}
                      </div>
                    )}

                    {/* Time HH:MM */}
                    <div>
                      <label
                        htmlFor="trigger-schedule-time"
                        className="block text-acc-text-secondary font-medium"
                      >
                        Dispatch Time (24-Hour HH:MM)
                      </label>
                      <input
                        id="trigger-schedule-time"
                        type="text"
                        disabled={readOnly}
                        maxLength={5}
                        placeholder="09:00"
                        value={node.trigger.schedule.time}
                        onChange={(e) => {
                          if (
                            node.trigger.kind === 'schedule' &&
                            node.trigger.schedule.type === 'recurring'
                          ) {
                            updateSchedule({
                              schedule: {
                                ...node.trigger.schedule,
                                time: e.target.value.trim(),
                              },
                            });
                          }
                        }}
                        className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 font-mono text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                      />
                      {!HHMM_REGEX.test(node.trigger.schedule.time) && (
                        <p className="mt-1 text-[11px] text-red-400">
                          Time must be in 24-hour HH:MM format (e.g. 09:30 or 14:00).
                        </p>
                      )}
                    </div>

                    {/* Time Zone */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label
                          htmlFor="trigger-schedule-timezone"
                          className="block text-acc-text-secondary font-medium"
                        >
                          Time Zone (IANA)
                        </label>
                        <button
                          type="button"
                          onClick={() => setCustomTimeZoneInput(!customTimeZoneInput)}
                          className="text-[10px] text-acc-accent hover:underline focus:outline-hidden"
                        >
                          {customTimeZoneInput ? 'Select common zone' : 'Enter custom zone'}
                        </button>
                      </div>

                      {customTimeZoneInput ||
                      !COMMON_TIME_ZONES.includes(node.trigger.schedule.timeZone) ? (
                        <input
                          id="trigger-schedule-timezone-custom"
                          aria-label="Custom Time Zone"
                          type="text"
                          disabled={readOnly}
                          value={node.trigger.schedule.timeZone}
                          onChange={(e) => {
                            if (
                              node.trigger.kind === 'schedule' &&
                              node.trigger.schedule.type === 'recurring'
                            ) {
                              updateSchedule({
                                schedule: {
                                  ...node.trigger.schedule,
                                  timeZone: e.target.value.trim(),
                                },
                              });
                            }
                          }}
                          placeholder="e.g. Asia/Kolkata, America/New_York"
                          className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 font-mono text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                        />
                      ) : (
                        <select
                          id="trigger-schedule-timezone"
                          disabled={readOnly}
                          value={node.trigger.schedule.timeZone}
                          onChange={(e) => {
                            if (
                              node.trigger.kind === 'schedule' &&
                              node.trigger.schedule.type === 'recurring'
                            ) {
                              updateSchedule({
                                schedule: {
                                  ...node.trigger.schedule,
                                  timeZone: e.target.value,
                                },
                              });
                            }
                          }}
                          className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                        >
                          {COMMON_TIME_ZONES.map((tz) => (
                            <option key={tz} value={tz}>
                              {tz}
                            </option>
                          ))}
                        </select>
                      )}

                      {!isJourneyTimeZone(node.trigger.schedule.timeZone) && (
                        <p className="mt-1 text-[11px] text-red-400">
                          Must be a valid IANA time zone recognized by Intl (e.g. UTC,
                          Asia/Kolkata).
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Simulation Preview */}
                <div className="rounded-md border border-acc-border/60 bg-acc-surface/70 p-2.5 text-[11px] space-y-1">
                  <div className="flex items-center gap-1.5 font-medium text-acc-text-secondary">
                    <svg
                      className="h-3.5 w-3.5 text-acc-accent"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>Next Firing Preview:</span>
                  </div>
                  {nextFire ? (
                    <p className="font-mono text-emerald-400 font-semibold pl-5">
                      {node.trigger.schedule.type === 'recurring' ? (
                        <>
                          {nextFire.toLocaleString(undefined, {
                            timeZone: isJourneyTimeZone(node.trigger.schedule.timeZone)
                              ? node.trigger.schedule.timeZone
                              : 'UTC',
                            timeZoneName: 'short',
                          })}{' '}
                          ({node.trigger.schedule.timeZone})
                        </>
                      ) : (
                        <>
                          {nextFire.toLocaleString(undefined, {
                            timeZoneName: 'short',
                          })}{' '}
                          (UTC: {nextFire.toISOString()})
                        </>
                      )}
                    </p>
                  ) : (
                    <p className="text-amber-400 italic pl-5">
                      No upcoming fire found. Check time, date, and weekday configuration.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- Send Message Config --- */}
        {node.type === 'send_message' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Dispatch Message</h4>
            <div>
              <label htmlFor="send-channel-select" className="block text-acc-text-secondary">
                Channel
              </label>
              <select
                id="send-channel-select"
                disabled={readOnly}
                value={node.channel}
                onChange={(e) =>
                  onChange({
                    ...node,
                    channel: e.target.value as JourneyChannel,
                  })
                }
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              >
                {JOURNEY_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {ch.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="send-template-input" className="block text-acc-text-secondary">
                Template ID
              </label>
              <input
                id="send-template-input"
                type="text"
                disabled={readOnly}
                value={node.templateId}
                onChange={(e) => onChange({ ...node, templateId: e.target.value })}
                placeholder="e.g. tpl_welcome_v1"
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="on-suppressed-select" className="block text-acc-text-secondary">
                  If Suppressed
                </label>
                <select
                  id="on-suppressed-select"
                  disabled={readOnly}
                  value={node.onSuppressed}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      onSuppressed: e.target.value as 'continue' | 'exit',
                    })
                  }
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2 py-1 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="continue">Continue</option>
                  <option value="exit">Exit Flow</option>
                </select>
              </div>

              <div>
                <label htmlFor="on-refused-select" className="block text-acc-text-secondary">
                  If Refused
                </label>
                <select
                  id="on-refused-select"
                  disabled={readOnly}
                  value={node.onRefused}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      onRefused: e.target.value as 'continue' | 'exit',
                    })
                  }
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2 py-1 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="continue">Continue</option>
                  <option value="exit">Exit Flow</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* --- Wait Duration Config --- */}
        {node.type === 'wait_duration' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Delay Duration</h4>
            <div>
              <label htmlFor="wait-duration-input" className="block text-acc-text-secondary">
                Seconds ({formatWaitSeconds(node.seconds)})
              </label>
              <input
                id="wait-duration-input"
                type="number"
                min={1}
                max={7776000}
                disabled={readOnly}
                value={node.seconds}
                onChange={(e) =>
                  onChange({
                    ...node,
                    seconds: Math.max(1, Number(e.target.value) || 1),
                  })
                }
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              />
            </div>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {[
                { label: '5m', sec: 300 },
                { label: '1h', sec: 3600 },
                { label: '1d', sec: 86400 },
                { label: '3d', sec: 259200 },
                { label: '7d', sec: 604800 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange({ ...node, seconds: preset.sec })}
                  className="rounded-md border border-acc-border bg-acc-surface px-2 py-0.5 text-[11px] text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* --- Wait Until Config --- */}
        {node.type === 'wait_until' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Wait Until</h4>
            <div>
              <label htmlFor="wait-until-at" className="block text-acc-text-secondary">
                At Timestamp (ISO-8601)
              </label>
              <input
                id="wait-until-at"
                type="text"
                disabled={readOnly}
                value={node.at}
                onChange={(e) => onChange({ ...node, at: e.target.value })}
                placeholder="2026-12-01T09:00:00Z"
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              />
            </div>
          </div>
        )}

        {/* --- Wait Window Config --- */}
        {node.type === 'wait_window' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Delivery Window</h4>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="window-start" className="block text-acc-text-secondary">
                  Start (HH:mm)
                </label>
                <input
                  id="window-start"
                  type="text"
                  disabled={readOnly}
                  value={node.startTime}
                  onChange={(e) => onChange({ ...node, startTime: e.target.value })}
                  placeholder="09:00"
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                />
              </div>
              <div>
                <label htmlFor="window-end" className="block text-acc-text-secondary">
                  End (HH:mm)
                </label>
                <input
                  id="window-end"
                  type="text"
                  disabled={readOnly}
                  value={node.endTime}
                  onChange={(e) => onChange({ ...node, endTime: e.target.value })}
                  placeholder="18:00"
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                />
              </div>
            </div>
            <div>
              <label htmlFor="window-tz" className="block text-acc-text-secondary">
                Time Zone (IANA)
              </label>
              <input
                id="window-tz"
                type="text"
                disabled={readOnly}
                value={node.timeZone}
                onChange={(e) => onChange({ ...node, timeZone: e.target.value })}
                placeholder="UTC, America/New_York"
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
              />
            </div>
          </div>
        )}

        {/* --- Condition Branch Config --- */}
        {node.type === 'condition' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Branching Rule</h4>
            <div>
              <label htmlFor="condition-kind-select" className="block text-acc-text-secondary">
                Rule Kind
              </label>
              <select
                id="condition-kind-select"
                disabled={readOnly}
                value={node.rule.kind}
                onChange={(e) => {
                  const kind = e.target.value;
                  if (kind === 'attribute') {
                    onChange({
                      ...node,
                      rule: { kind: 'attribute', field: 'firstName', op: 'exists' },
                    });
                  } else if (kind === 'tag') {
                    onChange({
                      ...node,
                      rule: { kind: 'tag', tag: 'VIP', present: true },
                    });
                  } else if (kind === 'consent') {
                    onChange({
                      ...node,
                      rule: {
                        kind: 'consent',
                        channel: 'whatsapp',
                        consentType: 'marketing',
                        granted: true,
                      },
                    });
                  }
                }}
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
              >
                <option value="attribute">Contact Attribute</option>
                <option value="tag">Contact Tag</option>
                <option value="consent">Consent Check</option>
              </select>
            </div>

            {node.rule.kind === 'attribute' && (
              <div className="space-y-2">
                <div>
                  <label htmlFor="attr-field" className="block text-acc-text-secondary">
                    Field (e.g. firstName, custom.vip_tier)
                  </label>
                  <input
                    id="attr-field"
                    type="text"
                    disabled={readOnly}
                    value={node.rule.field}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        rule: {
                          kind: 'attribute',
                          field: e.target.value,
                          op: node.rule.kind === 'attribute' ? node.rule.op : 'exists',
                          value: node.rule.kind === 'attribute' ? node.rule.value : undefined,
                        },
                      })
                    }
                    className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                  />
                </div>
                <div>
                  <label htmlFor="attr-op" className="block text-acc-text-secondary">
                    Operator
                  </label>
                  <select
                    id="attr-op"
                    disabled={readOnly}
                    value={node.rule.op}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        rule: {
                          kind: 'attribute',
                          field: node.rule.kind === 'attribute' ? node.rule.field : 'firstName',
                          op: e.target.value as 'exists' | 'not_exists' | 'eq' | 'neq',
                          value: node.rule.kind === 'attribute' ? node.rule.value : undefined,
                        },
                      })
                    }
                    className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                  >
                    <option value="exists">Exists</option>
                    <option value="not_exists">Does not exist</option>
                    <option value="eq">Equals (eq)</option>
                    <option value="neq">Not equals (neq)</option>
                  </select>
                </div>
                {(node.rule.op === 'eq' || node.rule.op === 'neq') && (
                  <div>
                    <label htmlFor="attr-val" className="block text-acc-text-secondary">
                      Value
                    </label>
                    <input
                      id="attr-val"
                      type="text"
                      disabled={readOnly}
                      value={node.rule.value || ''}
                      onChange={(e) =>
                        onChange({
                          ...node,
                          rule: {
                            kind: 'attribute',
                            field: node.rule.kind === 'attribute' ? node.rule.field : 'firstName',
                            op: node.rule.kind === 'attribute' ? node.rule.op : 'eq',
                            value: e.target.value,
                          },
                        })
                      }
                      className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                    />
                  </div>
                )}
              </div>
            )}

            {node.rule.kind === 'tag' && (
              <div className="space-y-2">
                <div>
                  <label htmlFor="tag-name" className="block text-acc-text-secondary">
                    Tag Name
                  </label>
                  <input
                    id="tag-name"
                    type="text"
                    disabled={readOnly}
                    value={node.rule.tag}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        rule: {
                          kind: 'tag',
                          tag: e.target.value,
                          present: node.rule.kind === 'tag' ? node.rule.present : true,
                        },
                      })
                    }
                    className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                  />
                </div>
                <div>
                  <label htmlFor="tag-present" className="block text-acc-text-secondary">
                    Condition
                  </label>
                  <select
                    id="tag-present"
                    disabled={readOnly}
                    value={node.rule.present ? 'true' : 'false'}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        rule: {
                          kind: 'tag',
                          tag: node.rule.kind === 'tag' ? node.rule.tag : 'VIP',
                          present: e.target.value === 'true',
                        },
                      })
                    }
                    className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden"
                  >
                    <option value="true">Tag is present</option>
                    <option value="false">Tag is NOT present</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- Exit Config --- */}
        {node.type === 'exit' && (
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Exit Journey</h4>
            <div>
              <label htmlFor="exit-reason-input" className="block text-acc-text-secondary">
                Exit Reason (Optional)
              </label>
              <input
                id="exit-reason-input"
                type="text"
                disabled={readOnly}
                value={node.reason || ''}
                onChange={(e) => onChange({ ...node, reason: e.target.value || undefined })}
                placeholder="e.g. goal_met, unsubscribed, completed"
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              />
            </div>
          </div>
        )}

        {/* --- Outgoing Edge Routing --- */}
        <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
          <h4 className="font-semibold text-acc-text-primary">Outgoing Transition</h4>

          {node.type === 'exit' && (
            <p className="text-acc-text-secondary italic">Terminal step: flow terminates here.</p>
          )}

          {'next' in node && (
            <div>
              <label htmlFor="next-node-select" className="block text-acc-text-secondary">
                Next Step Target
              </label>
              <select
                id="next-node-select"
                disabled={readOnly}
                value={node.next}
                onChange={(e) => onChange({ ...node, next: e.target.value })}
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              >
                <option value="">(Select Target Node)</option>
                {candidateTargets.map((targetKey) => (
                  <option key={targetKey} value={targetKey}>
                    {getNodeDisplayLabel(targetKey, graph.nodes[targetKey]!)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {'onTrue' in node && (
            <div className="space-y-2">
              <div>
                <label htmlFor="ontrue-node-select" className="block text-emerald-400 font-medium">
                  If True (Match)
                </label>
                <select
                  id="ontrue-node-select"
                  disabled={readOnly}
                  value={node.onTrue}
                  onChange={(e) => onChange({ ...node, onTrue: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="">(Select Target Node)</option>
                  {candidateTargets.map((targetKey) => (
                    <option key={targetKey} value={targetKey}>
                      {getNodeDisplayLabel(targetKey, graph.nodes[targetKey]!)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="onfalse-node-select" className="block text-rose-400 font-medium">
                  If False (No Match)
                </label>
                <select
                  id="onfalse-node-select"
                  disabled={readOnly}
                  value={node.onFalse}
                  onChange={(e) => onChange({ ...node, onFalse: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="">(Select Target Node)</option>
                  {candidateTargets.map((targetKey) => (
                    <option key={targetKey} value={targetKey}>
                      {getNodeDisplayLabel(targetKey, graph.nodes[targetKey]!)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {'onOutcome' in node && (
            <div className="space-y-2">
              <div>
                <label
                  htmlFor="onoutcome-node-select"
                  className="block text-indigo-400 font-medium"
                >
                  On Outcome Met
                </label>
                <select
                  id="onoutcome-node-select"
                  disabled={readOnly}
                  value={node.onOutcome}
                  onChange={(e) => onChange({ ...node, onOutcome: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="">(Select Target Node)</option>
                  {candidateTargets.map((targetKey) => (
                    <option key={targetKey} value={targetKey}>
                      {getNodeDisplayLabel(targetKey, graph.nodes[targetKey]!)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="ontimeout-node-select" className="block text-amber-400 font-medium">
                  On Timeout
                </label>
                <select
                  id="ontimeout-node-select"
                  disabled={readOnly}
                  value={node.onTimeout}
                  onChange={(e) => onChange({ ...node, onTimeout: e.target.value })}
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                >
                  <option value="">(Select Target Node)</option>
                  {candidateTargets.map((targetKey) => (
                    <option key={targetKey} value={targetKey}>
                      {getNodeDisplayLabel(targetKey, graph.nodes[targetKey]!)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer / Delete node */}
      {!readOnly && !isEntry && onDelete && (
        <div className="border-t border-acc-border p-4">
          <button
            type="button"
            onClick={() => onDelete(nodeKey)}
            className="w-full rounded-lg border border-red-500/30 bg-red-500/10 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/20 focus:outline-hidden"
          >
            Delete This Step
          </button>
        </div>
      )}
    </aside>
  );
}
