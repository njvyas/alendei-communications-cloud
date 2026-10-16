'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, messagesApi, templatesApi, workspacesApi } from '@/lib/api-client';
import { useCanSendMessages } from '@/lib/session-store';

interface WhatsAppSendPanelProps {
  onMessageDispatched: (messageId: string) => void;
  activeMessageId?: string | null;
}

export function WhatsAppSendPanel({
  onMessageDispatched,
  activeMessageId: _activeMessageId,
}: WhatsAppSendPanelProps) {
  const canSendMessages = useCanSendMessages();

  // State
  const [workspaceId, setWorkspaceId] = useState('');
  const [recipient, setRecipient] = useState('+12025550199');
  const [sendMode, setSendMode] = useState<'template' | 'custom'>('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState('Hello from Alendei Communications Cloud!');
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [manualMessageId, setManualMessageId] = useState('');

  // Fetch workspaces
  const { data: workspacesData, isLoading: isWorkspacesLoading } = useQuery({
    queryKey: ['workspaces', 'list', { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
  });

  const workspaces = workspacesData?.data ?? [];
  const activeWorkspaceId = workspaceId || (workspaces.length > 0 ? workspaces[0]!.id : '');

  // Fetch approved templates
  const { data: templatesData, isLoading: isTemplatesLoading } = useQuery({
    queryKey: ['templates', 'list', { approvalStatus: 'approved' }],
    queryFn: ({ signal }) => templatesApi.list({ approvalStatus: 'approved', limit: 50 }, signal),
  });

  const approvedTemplates = templatesData?.data ?? [];
  const activeTemplate =
    approvedTemplates.find((t) => t.id === selectedTemplateId) ?? approvedTemplates[0];

  const handleTemplateChange = (tplId: string) => {
    setSelectedTemplateId(tplId);
    setTemplateVariables({});
  };

  const handleVariableChange = (variableName: string, value: string) => {
    setTemplateVariables((prev) => ({ ...prev, [variableName]: value }));
  };

  const handleRegenerateKey = () => {
    setIdempotencyKey(crypto.randomUUID());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient) {
      setErrorMessage('Recipient phone number is required.');
      return;
    }

    if (!/^\+[1-9]\d{1,14}$/.test(trimmedRecipient)) {
      setErrorMessage(
        'Recipient phone number must be in valid E.164 international format (e.g. +12025550199).',
      );
      return;
    }

    let payload: Record<string, unknown>;
    let targetTemplateId: string | undefined;

    if (sendMode === 'template') {
      if (!activeTemplate) {
        setErrorMessage('An approved template is required for template dispatch.');
        return;
      }
      targetTemplateId = activeTemplate.id;
      payload = {
        templateId: activeTemplate.id,
        templateName: activeTemplate.name,
        variables: templateVariables,
      };
    } else {
      payload = {
        text: customText.trim(),
      };
    }

    setIsSubmitting(true);
    try {
      const res = await messagesApi.send(
        {
          channelCode: 'whatsapp',
          recipient: trimmedRecipient,
          workspaceId: activeWorkspaceId || undefined,
          templateId: targetTemplateId,
          payload,
        },
        idempotencyKey,
      );

      // Successfully queued message!
      onMessageDispatched(res.data.id);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to dispatch message.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while dispatching the message.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualLookup = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualMessageId.trim()) {
      onMessageDispatched(manualMessageId.trim());
      setManualMessageId('');
    }
  };

  return (
    <div className="space-y-6">
      {/* Send Form Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xs">
        <div className="border-b border-[var(--color-border-subtle)] pb-4">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">
            Dispatch WhatsApp Test Message
          </h2>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Asynchronously enqueue a WhatsApp message through the simulator pipeline to observe
            orchestrator dispatch, fencing, and fallback
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {errorMessage && (
            <div
              className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400"
              role="alert"
            >
              {errorMessage}
            </div>
          )}

          {/* Workspace selection */}
          <div>
            <label
              htmlFor="send-workspace"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Sending Workspace
            </label>
            <select
              id="send-workspace"
              value={activeWorkspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              disabled={isWorkspacesLoading || isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name} ({ws.id.slice(0, 8)}…)
                </option>
              ))}
            </select>
          </div>

          {/* Recipient */}
          <div>
            <label
              htmlFor="send-recipient"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Recipient Phone Number (E.164)
            </label>
            <input
              id="send-recipient"
              type="tel"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={isSubmitting}
              placeholder="+12025550199"
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] font-mono"
              required
            />
          </div>

          {/* Mode Switcher */}
          <div className="flex gap-4 border-b border-[var(--color-border-subtle)] pb-2 text-xs">
            <button
              type="button"
              onClick={() => setSendMode('template')}
              className={`pb-1 font-medium transition-colors ${
                sendMode === 'template'
                  ? 'border-b-2 border-emerald-500 text-emerald-400'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              Approved Template Message
            </button>
            <button
              type="button"
              onClick={() => setSendMode('custom')}
              className={`pb-1 font-medium transition-colors ${
                sendMode === 'custom'
                  ? 'border-b-2 border-emerald-500 text-emerald-400'
                  : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              Custom Payload / Text
            </button>
          </div>

          {/* Template mode */}
          {sendMode === 'template' && (
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="send-template"
                  className="block text-xs font-medium text-[var(--color-ink-muted)]"
                >
                  Select Approved Template
                </label>
                {approvedTemplates.length === 0 ? (
                  <p className="mt-1 text-xs text-amber-400">
                    No approved templates found. Please create a template and use{' '}
                    <em>Simulate Approval</em> in the Templates section.
                  </p>
                ) : (
                  <select
                    id="send-template"
                    value={activeTemplate?.id ?? ''}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    disabled={isTemplatesLoading || isSubmitting}
                    className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
                  >
                    {approvedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} (ID: {t.id.slice(0, 8)}…)
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {activeTemplate && (
                <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                  <p className="text-[11px] font-medium text-[var(--color-ink-muted)]">
                    Template Body:
                  </p>
                  <p className="mt-1 font-mono text-xs text-[var(--color-ink)]">
                    {activeTemplate.body}
                  </p>

                  {activeTemplate.variables && activeTemplate.variables.length > 0 && (
                    <div className="mt-3 space-y-2 border-t border-[var(--color-border-subtle)] pt-2">
                      <p className="text-[11px] font-medium text-[var(--color-ink-muted)]">
                        Template Parameters:
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {activeTemplate.variables.map((v) => (
                          <div key={v}>
                            <label
                              htmlFor={`var-${v}`}
                              className="block text-[10px] text-[var(--color-ink-muted)]"
                            >
                              {`{{${v}}}`}
                            </label>
                            <input
                              id={`var-${v}`}
                              type="text"
                              value={templateVariables[v] ?? ''}
                              onChange={(e) => handleVariableChange(v, e.target.value)}
                              disabled={isSubmitting}
                              placeholder={`Value for ${v}`}
                              className="mt-0.5 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Custom text mode */}
          {sendMode === 'custom' && (
            <div>
              <label
                htmlFor="send-custom-text"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Custom Message Text
              </label>
              <textarea
                id="send-custom-text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                disabled={isSubmitting}
                rows={3}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] font-mono"
              />
            </div>
          )}

          {/* Idempotency Key Callout */}
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[var(--color-ink-muted)]">Idempotency Key:</span>
              <button
                type="button"
                onClick={handleRegenerateKey}
                disabled={isSubmitting}
                className="text-[11px] text-emerald-400 hover:underline"
              >
                Regenerate for New Send
              </button>
            </div>
            <p className="mt-1 font-mono text-[11px] text-[var(--color-ink)] truncate">
              {idempotencyKey}
            </p>
            <p className="mt-1 text-[10px] text-[var(--color-ink-muted)]">
              Retries reuse this exact key to demonstrate server-side idempotent deduplication (202
              replay).
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={isSubmitting || !canSendMessages}
              data-testid="send-message-btn"
              className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 shadow-xs"
            >
              {isSubmitting ? 'Enqueuing Message…' : 'Send WhatsApp Message'}
            </button>
          </div>
        </form>
      </div>

      {/* Manual lookup card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-xs">
        <form
          onSubmit={handleManualLookup}
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex-1 min-w-[240px]">
            <label
              htmlFor="manual-msg-id"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Inspect Existing Message by UUID
            </label>
            <input
              id="manual-msg-id"
              type="text"
              value={manualMessageId}
              onChange={(e) => setManualMessageId(e.target.value)}
              placeholder="e.g. 01955b0a-7b3b-7411-9a4f-..."
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] font-mono"
            />
          </div>
          <button
            type="submit"
            className="mt-5 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Load Message
          </button>
        </form>
      </div>
    </div>
  );
}
