'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contactsApi } from '@/lib/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  generateContactTimeline,
  type ActivityCategory,
  type ActivityTimelineItem,
  type ContactMessageActivityRecord,
} from '@/lib/cdp';
import type { ContactIdentityResponse, ContactResponse } from '@acc/contracts';

interface ContactTimelineCardProps {
  readonly contact: ContactResponse;
  readonly identities?: readonly ContactIdentityResponse[];
  readonly messages?: readonly ContactMessageActivityRecord[];
}

export function ContactTimelineCard({
  contact,
  identities = [],
  messages = [],
}: ContactTimelineCardProps) {
  const [selectedCategory, setSelectedCategory] = useState<ActivityCategory | 'all'>('all');
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  // Load consent events for this contact
  const { data: consentData } = useQuery({
    queryKey: ['contacts', 'consent-events', contact.id],
    queryFn: ({ signal }) => contactsApi.listConsentEvents(contact.id, signal),
  });
  const consentEvents = consentData?.data ?? [];

  // Synthesize complete timeline from authentic records
  const timelineItems = generateContactTimeline(contact, identities, consentEvents, messages);

  const filteredItems =
    selectedCategory === 'all'
      ? timelineItems
      : timelineItems.filter((item) => item.category === selectedCategory);

  const toggleExpand = (id: string) => {
    setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const counts: Record<ActivityCategory | 'all', number> = {
    all: timelineItems.length,
    message: timelineItems.filter((i) => i.category === 'message').length,
    consent: timelineItems.filter((i) => i.category === 'consent').length,
    identity: timelineItems.filter((i) => i.category === 'identity').length,
    profile: timelineItems.filter((i) => i.category === 'profile').length,
  };

  const getToneClasses = (tone: ActivityTimelineItem['statusTone']) => {
    switch (tone) {
      case 'success':
        return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
      case 'error':
        return 'border-rose-500/30 bg-rose-500/10 text-rose-400';
      case 'warning':
        return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
      case 'accent':
        return 'border-indigo-500/30 bg-indigo-500/10 text-indigo-400';
      default:
        return 'border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]';
    }
  };

  const getIconForType = (type: ActivityTimelineItem['type']) => {
    switch (type) {
      case 'message_read':
        return '✓✓';
      case 'message_delivered':
        return '✓';
      case 'message_sent':
        return '✉';
      case 'message_failed':
        return '✕';
      case 'consent_granted':
        return '🛡+';
      case 'consent_revoked':
        return '🛡✕';
      case 'identity_added':
      case 'identity_updated':
        return '🔗';
      case 'contact_created':
        return '👤';
      case 'field_updated':
      case 'tag_added':
      case 'tag_removed':
        return '🏷';
      default:
        return '•';
    }
  };

  return (
    <Card className="border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Activity & Engagement Timeline</CardTitle>
            <CardDescription>
              Chronological record of communication touchpoints, delivery outcomes, and consent
              lifecycle
            </CardDescription>
          </div>

          {/* Filter Pills */}
          <div className="flex flex-wrap gap-1" data-testid="timeline-filters">
            {(['all', 'message', 'consent', 'identity', 'profile'] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                data-testid={`filter-timeline-${cat}`}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  selectedCategory === cat
                    ? 'bg-indigo-600 text-white'
                    : 'bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                <span className="capitalize">{cat === 'all' ? 'All Activities' : cat}</span>
                <span className="ml-1 opacity-70">({counts[cat]})</span>
              </button>
            ))}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {filteredItems.length === 0 ? (
          selectedCategory === 'message' ? (
            <div
              className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-8 text-center"
              data-testid="timeline-empty-messages"
            >
              <div className="mx-auto mb-2 flex size-9 items-center justify-center rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] text-sm text-[var(--color-ink-muted)]">
                ✉
              </div>
              <p className="font-semibold text-xs text-[var(--color-ink)]">
                Historical message activity not yet available
              </p>
              <p className="mt-1 max-w-sm mx-auto text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
                Message dispatch records, delivery receipts, and read outcomes will be displayed
                here once contact message history is supported by the backend API.
              </p>
            </div>
          ) : (
            <div
              className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-8 text-center text-xs text-[var(--color-ink-muted)]"
              data-testid="timeline-empty-category"
            >
              No activities recorded under the &quot;{selectedCategory}&quot; category.
            </div>
          )
        ) : (
          <div
            className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-[var(--color-border-subtle)]"
            data-testid="activity-timeline"
          >
            {filteredItems.map((item) => {
              const isExpanded = Boolean(expandedItems[item.id]);
              const hasMetadata = item.metadata && Object.keys(item.metadata).length > 0;

              return (
                <div
                  key={item.id}
                  data-testid={`timeline-item-${item.id}`}
                  className="relative group"
                >
                  {/* Timeline Node Icon */}
                  <div
                    className={`absolute -left-6 top-1 flex size-5 items-center justify-center rounded-full border text-[10px] font-bold shadow-xs ${getToneClasses(
                      item.statusTone,
                    )}`}
                    aria-hidden="true"
                  >
                    {getIconForType(item.type)}
                  </div>

                  {/* Event Content Card */}
                  <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 text-xs transition-colors hover:border-[var(--color-ink-muted)]/40">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--color-ink)]">{item.title}</span>
                        {item.channelCode && (
                          <span className="rounded bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.2 font-mono text-[9px] uppercase font-bold">
                            {item.channelCode}
                          </span>
                        )}
                        <span className="rounded-full bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-2 py-0.2 text-[10px] capitalize text-[var(--color-ink-muted)]">
                          {item.category}
                        </span>
                      </div>

                      <time
                        dateTime={item.timestamp}
                        title={new Date(item.timestamp).toISOString()}
                        className="font-mono text-[11px] text-[var(--color-ink-muted)] shrink-0"
                      >
                        {new Date(item.timestamp).toLocaleString()}
                      </time>
                    </div>

                    {item.description && (
                      <p className="mt-1 text-xs text-[var(--color-ink-muted)] leading-relaxed">
                        {item.description}
                      </p>
                    )}

                    {/* Expandable Metadata */}
                    {hasMetadata && (
                      <div className="mt-2 pt-2 border-t border-[var(--color-border-subtle)]/50">
                        <button
                          type="button"
                          onClick={() => toggleExpand(item.id)}
                          data-testid={`toggle-meta-${item.id}`}
                          className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300"
                        >
                          {isExpanded ? 'Hide Details ▲' : 'View Payload Details ▼'}
                        </button>

                        {isExpanded && (
                          <pre className="mt-2 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-2 font-mono text-[10px] text-[var(--color-ink)] overflow-x-auto">
                            {JSON.stringify(item.metadata, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
