'use client';

import {
  JOURNEY_CHANNELS,
  JOURNEY_TRIGGER_EVENTS,
  formatWaitSeconds,
  getNodeDisplayLabel,
  getNodeTypeLabel,
  type JourneyChannel,
  type JourneyGraph,
  type JourneyNode,
  type JourneyTriggerEvent,
} from '@/lib/journeys';
import { JourneyNodeIcon, getNodeTypeColorClass } from './journey-node-icon';

export interface JourneyNodeInspectorProps {
  readonly nodeKey: string;
  readonly node: JourneyNode;
  readonly graph: JourneyGraph;
  readonly readOnly?: boolean;
  readonly onChange: (updatedNode: JourneyNode) => void;
  readonly onDelete?: (nodeKey: string) => void;
  readonly onClose: () => void;
}

export function JourneyNodeInspector({
  nodeKey,
  node,
  graph,
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
          <div className="space-y-3 rounded-lg border border-acc-border/60 bg-acc-surface-raised/30 p-3">
            <h4 className="font-semibold text-acc-text-primary">Trigger Configuration</h4>
            <div>
              <label htmlFor="trigger-kind-select" className="block text-acc-text-secondary">
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
                        segmentId: '00000000-0000-0000-0000-000000000001',
                        schedule: { type: 'once', at: new Date().toISOString() },
                      },
                    });
                  }
                }}
                className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
              >
                <option value="api">Inbound API</option>
                <option value="event">Platform Event</option>
                <option value="schedule">Segment Schedule</option>
              </select>
            </div>

            {node.trigger.kind === 'event' && (
              <div className="space-y-2">
                <div>
                  <label htmlFor="trigger-event-select" className="block text-acc-text-secondary">
                    Event Type
                  </label>
                  <select
                    id="trigger-event-select"
                    disabled={readOnly}
                    value={node.trigger.event}
                    onChange={(e) =>
                      onChange({
                        ...node,
                        trigger: {
                          kind: 'event',
                          event: e.target.value as JourneyTriggerEvent,
                          tag: node.trigger.kind === 'event' ? node.trigger.tag : undefined,
                        },
                      })
                    }
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
                    <label htmlFor="trigger-tag-input" className="block text-acc-text-secondary">
                      Tag (Optional Filter)
                    </label>
                    <input
                      id="trigger-tag-input"
                      type="text"
                      disabled={readOnly}
                      value={node.trigger.tag || ''}
                      onChange={(e) =>
                        onChange({
                          ...node,
                          trigger: {
                            kind: 'event',
                            event: 'contact.tag_added',
                            tag: e.target.value || undefined,
                          },
                        })
                      }
                      placeholder="e.g. VIP"
                      className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                    />
                  </div>
                )}
              </div>
            )}

            {node.trigger.kind === 'schedule' && (
              <div>
                <label htmlFor="trigger-segment-input" className="block text-acc-text-secondary">
                  Segment UUID
                </label>
                <input
                  id="trigger-segment-input"
                  type="text"
                  disabled={readOnly}
                  value={node.trigger.segmentId}
                  onChange={(e) =>
                    onChange({
                      ...node,
                      trigger: {
                        kind: 'schedule',
                        segmentId: e.target.value,
                        schedule:
                          node.trigger.kind === 'schedule'
                            ? node.trigger.schedule
                            : { type: 'once', at: new Date().toISOString() },
                      },
                    })
                  }
                  className="mt-1 block w-full rounded-md border border-acc-border bg-acc-surface-raised px-2.5 py-1.5 text-xs focus:border-acc-accent focus:outline-hidden disabled:opacity-50"
                />
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
