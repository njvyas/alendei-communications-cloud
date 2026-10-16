'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, messagesApi } from '@/lib/api-client';
import { useCanReadMessages, useCanSendMessages } from '@/lib/session-store';
import { WhatsAppSendPanel } from '@/components/whatsapp/whatsapp-send-panel';
import { AttemptHistoryCard } from '@/components/whatsapp/attempt-history-card';

const TERMINAL_STATUSES = ['accepted', 'failed', 'outcome_unknown'];

export default function WhatsAppPage() {
  const canReadMessages = useCanReadMessages();
  const canSendMessages = useCanSendMessages();

  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);

  // Poll active message details while not terminal
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['messages', 'detail', activeMessageId],
    queryFn: ({ signal }) => messagesApi.get(activeMessageId!, signal),
    enabled: Boolean(canReadMessages && activeMessageId),
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status;
      if (!status || TERMINAL_STATUSES.includes(status)) {
        return false;
      }
      return 1000; // Poll every 1s while in-flight (queued, routing, submitting)
    },
  });

  const message = data?.data;
  const isPolling = Boolean(
    activeMessageId && message && !TERMINAL_STATUSES.includes(message.status) && isFetching,
  );

  if (!canReadMessages && !canSendMessages) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to access WhatsApp messaging. This section requires{' '}
          <code className="text-xs">messages.read</code> or{' '}
          <code className="text-xs">messages.send</code> for the active organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
          WhatsApp Management Console
        </h1>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Outbound WhatsApp dispatch simulator, provider settlement timeline, and failure fallback
          monitoring
        </p>
      </div>

      {/* Settlement Monitor (visible if an active message is tracked) */}
      {activeMessageId && (
        <div className="space-y-4">
          {error ? (
            <div
              className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
              role="alert"
            >
              {error instanceof ApiError
                ? `Failed to load message (${error.code}): ${error.message}`
                : 'Failed to retrieve message status.'}
            </div>
          ) : isLoading ? (
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center text-xs text-[var(--color-ink-muted)] shadow-xs">
              Fetching message status and dispatch timeline…
            </div>
          ) : message ? (
            <AttemptHistoryCard message={message} isPolling={isPolling} />
          ) : null}
        </div>
      )}

      {/* Send Test Panel */}
      <WhatsAppSendPanel
        onMessageDispatched={(id) => setActiveMessageId(id)}
        activeMessageId={activeMessageId}
      />
    </div>
  );
}
