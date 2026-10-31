'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, channelsApi, templatesApi } from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';

interface TemplateCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultChannelId?: string;
}

export function TemplateCreateDialog({
  open,
  onOpenChange,
  defaultChannelId,
}: TemplateCreateDialogProps) {
  const queryClient = useQueryClient();

  const [channelId, setChannelId] = useState(defaultChannelId ?? '');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [variablesInput, setVariablesInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  // Fetch channels to select WhatsApp channel
  const { data: channelsData, isLoading: isChannelsLoading } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50 }, signal),
    enabled: open,
  });

  const channels = channelsData?.data ?? [];
  const whatsappChannel = channels.find((c) => c.code === 'whatsapp');

  const modal = useModalDialog(open);

  if (!open) return null;

  const handleClose = () => {
    setName('');
    setBody('');
    setVariablesInput('');
    setErrorMessage(null);
    setIdempotencyKey(crypto.randomUUID());
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const effectiveChannelId = channelId || whatsappChannel?.id;
    if (!effectiveChannelId) {
      setErrorMessage('Please select a communication channel (WhatsApp).');
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('Template name is required.');
      return;
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      setErrorMessage('Template body text is required.');
      return;
    }

    // Extract variables from body or input
    const extractedFromTokens = Array.from(trimmedBody.matchAll(/\{\{([^}]+)\}\}/g))
      .map((m) => m[1]?.trim())
      .filter((v): v is string => Boolean(v));
    const manualVars = variablesInput
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const combinedVariables: string[] = Array.from(
      new Set([...extractedFromTokens, ...manualVars]),
    );

    setIsSubmitting(true);
    try {
      await templatesApi.create(
        {
          channelId: effectiveChannelId,
          name: trimmedName,
          body: trimmedBody,
          variables: combinedVariables.length > 0 ? combinedVariables : undefined,
        },
        idempotencyKey,
      );

      await queryClient.invalidateQueries({ queryKey: ['templates', 'list'] });
      handleClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to create template.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while creating the template.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(handleClose, !isSubmitting)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-create-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2
            id="template-create-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Create WhatsApp Template
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
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

          <div>
            <label
              htmlFor="template-channel"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Channel
            </label>
            <select
              id="template-channel"
              value={channelId || whatsappChannel?.id || ''}
              onChange={(e) => setChannelId(e.target.value)}
              disabled={isChannelsLoading || isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code.toUpperCase()} — {c.status}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="template-name"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Template Name
            </label>
            <input
              id="template-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. order_update_v1"
              maxLength={200}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
              required
            />
          </div>

          <div>
            <label
              htmlFor="template-body"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Body Text (supports placeholders like {'{{1}}'}, {'{{2}}'})
            </label>
            <textarea
              id="template-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={isSubmitting}
              rows={4}
              placeholder="Hello {{1}}, your order {{2}} has been confirmed."
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] font-mono"
              required
            />
          </div>

          <div>
            <label
              htmlFor="template-variables"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Variables (comma-separated, auto-detected from placeholders)
            </label>
            <input
              id="template-variables"
              type="text"
              value={variablesInput}
              onChange={(e) => setVariablesInput(e.target.value)}
              disabled={isSubmitting}
              placeholder="e.g. 1, 2, customer_name"
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            />
          </div>

          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] text-[var(--color-ink-muted)]">
            <span className="font-semibold text-amber-500">Internal Simulator Lifecycle:</span> New
            templates are created with internal status <code className="text-xs">draft</code>. Use
            the <em>Simulate Approval</em> action to transition them to{' '}
            <code className="text-xs">approved</code> before dispatching messages. No external Meta
            calls occur in Phase 3.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating…' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
