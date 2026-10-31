'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  channelsApi,
  messagesApi,
  templatesApi,
  workspacesApi,
  type ChannelCode,
  type ChannelView,
} from '@/lib/api-client';
import { useCanSendMessages, useSession } from '@/lib/session-store';
import { resolveActiveWorkspaceId } from '@/components/contacts/workspace-selection';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

export interface MessageDispatchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMessageDispatched?: (messageId: string) => void;
  readonly channels?: readonly ChannelView[];
  readonly initialChannelCode?: ChannelCode;
}

export function MessageDispatchDialog({
  open,
  onOpenChange,
  onMessageDispatched,
  channels: propChannels,
  initialChannelCode = 'whatsapp',
}: MessageDispatchDialogProps) {
  const canSend = useCanSendMessages();
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  // Form State
  const [channelCode, setChannelCode] = useState<string>(initialChannelCode);
  const [workspaceId, setWorkspaceId] = useState('');
  const [recipient, setRecipient] = useState('+12025550199');
  const [sendMode, setSendMode] = useState<'template' | 'custom'>('custom');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templateVariables, setTemplateVariables] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState('Hello from Alendei Communications Cloud!');

  // SMS DLT fields
  const [dltEntityId, setDltEntityId] = useState('');
  const [dltTemplateId, setDltTemplateId] = useState('');
  const [dltHeaderId, setDltHeaderId] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modal = useModalDialog(open);

  // Query channels if not provided
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', selectedOrgId],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: Boolean(open && selectedOrgId && !propChannels),
  });

  const channels = propChannels ?? channelsData?.data ?? [];
  const activeChannel = channels.find((c) => c.code === channelCode);

  // Workspaces of the active organization
  const { data: workspacesData, isLoading: isWorkspacesLoading } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrgId, { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(open && selectedOrgId),
  });

  const workspaces = workspacesData?.data ?? [];
  const activeWorkspaceId = resolveActiveWorkspaceId(workspaceId, workspaces);

  // Templates query for current channel
  const { data: templatesData, isLoading: isTemplatesLoading } = useQuery({
    queryKey: [
      'templates',
      'list',
      selectedOrgId,
      { channelId: activeChannel?.id, approvalStatus: 'approved' },
    ],
    queryFn: ({ signal }) =>
      templatesApi.list(
        { channelId: activeChannel!.id, approvalStatus: 'approved', limit: 50 },
        signal,
      ),
    enabled: Boolean(open && selectedOrgId && activeChannel?.id && sendMode === 'template'),
  });

  const approvedTemplates = templatesData?.data ?? [];
  const activeTemplate =
    approvedTemplates.find((t) => t.id === selectedTemplateId) ?? approvedTemplates[0];

  if (!open) return null;

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleChannelChange = (newCode: string) => {
    setChannelCode(newCode);
    setSelectedTemplateId('');
    setTemplateVariables({});
    setErrorMessage(null);
    // WhatsApp defaults to template if templates available, else custom
    if (newCode !== 'whatsapp') {
      setSendMode('custom');
    }
  };

  const handleTemplateChange = (tplId: string) => {
    setSelectedTemplateId(tplId);
    setTemplateVariables({});
  };

  const handleVariableChange = (varName: string, val: string) => {
    setTemplateVariables((prev) => ({ ...prev, [varName]: val }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient) {
      setErrorMessage('Recipient address is required.');
      return;
    }

    if (!/^\+[1-9]\d{1,14}$/.test(trimmedRecipient)) {
      setErrorMessage(
        'Recipient address must be in valid E.164 international format (e.g. +12025550199).',
      );
      return;
    }

    let payload: Record<string, unknown>;
    let targetTemplateId: string | undefined;

    if (channelCode === 'whatsapp' && sendMode === 'template') {
      if (!activeTemplate) {
        setErrorMessage('An approved WhatsApp template is required for template dispatch.');
        return;
      }
      targetTemplateId = activeTemplate.id;
      payload = {
        templateId: activeTemplate.id,
        templateName: activeTemplate.name,
        variables: templateVariables,
      };
    } else if (channelCode === 'sms') {
      const text = customText.trim();
      if (!text) {
        setErrorMessage('SMS message body is required.');
        return;
      }
      payload = {
        text,
        ...(dltEntityId.trim() || dltTemplateId.trim() || dltHeaderId.trim()
          ? {
              dlt: {
                ...(dltEntityId.trim() ? { entityId: dltEntityId.trim() } : {}),
                ...(dltTemplateId.trim() ? { templateId: dltTemplateId.trim() } : {}),
                ...(dltHeaderId.trim() ? { headerId: dltHeaderId.trim() } : {}),
              },
            }
          : {}),
      };
    } else {
      const text = customText.trim();
      if (!text) {
        setErrorMessage('Message text is required.');
        return;
      }
      payload = { text };
    }

    setIsSubmitting(true);
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await messagesApi.send(
        {
          channelCode,
          recipient: trimmedRecipient,
          workspaceId: activeWorkspaceId || undefined,
          templateId: targetTemplateId,
          payload,
        },
        idempotencyKey,
      );

      toast.success(
        `Message dispatched via ${channelCode.toUpperCase()} (${res.data.status.toUpperCase()})`,
      );
      handleClose();
      if (onMessageDispatched) {
        onMessageDispatched(res.data.id);
      }
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(handleClose, !isSubmitting)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="message-dispatch-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl outline-hidden my-8"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <div>
            <h2
              id="message-dispatch-title"
              className="text-base font-semibold text-[var(--color-ink)]"
            >
              Dispatch Message
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Submit an outbound communication dispatch across supported channels.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {!canSend && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-400">
            You do not have permission (<code>messages.send</code>) to dispatch messages for this
            organization.
          </div>
        )}

        {errorMessage && (
          <div
            className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Channel Selector */}
          <div>
            <label
              htmlFor="dispatch-channel"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Channel
            </label>
            <select
              id="dispatch-channel"
              value={channelCode}
              onChange={(e) => handleChannelChange(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              {channels.length === 0 ? (
                <>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="sms">SMS</option>
                  <option value="rcs">RCS</option>
                </>
              ) : (
                channels.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.displayName || c.code.toUpperCase()} ({c.code.toUpperCase()})
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Workspace Selector */}
          <div>
            <label
              htmlFor="dispatch-workspace"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Workspace
            </label>
            <select
              id="dispatch-workspace"
              value={activeWorkspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              disabled={isSubmitting || isWorkspacesLoading || workspaces.length === 0}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              {workspaces.length === 0 ? (
                <option value="">No workspaces available</option>
              ) : (
                workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} {ws.isDefault ? '(Default)' : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Recipient Address */}
          <div>
            <label
              htmlFor="dispatch-recipient"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Recipient Address (E.164)
            </label>
            <input
              id="dispatch-recipient"
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="+12025550199"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-xs text-[var(--color-ink)]"
            />
          </div>

          {/* Mode Selector for WhatsApp */}
          {channelCode === 'whatsapp' && (
            <div>
              <label className="block text-xs font-medium text-[var(--color-ink)] mb-1">
                Dispatch Mode
              </label>
              <div className="flex gap-4 text-xs">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="sendMode"
                    value="template"
                    checked={sendMode === 'template'}
                    onChange={() => setSendMode('template')}
                    disabled={isSubmitting}
                  />
                  <span>Approved Template</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="sendMode"
                    value="custom"
                    checked={sendMode === 'custom'}
                    onChange={() => setSendMode('custom')}
                    disabled={isSubmitting}
                  />
                  <span>Custom Text</span>
                </label>
              </div>
            </div>
          )}

          {/* WhatsApp Template Mode Fields */}
          {channelCode === 'whatsapp' && sendMode === 'template' && (
            <div className="space-y-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/40 p-3">
              <div>
                <label
                  htmlFor="dispatch-template"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Template
                </label>
                {isTemplatesLoading ? (
                  <div role="status" className="mt-1 text-xs text-[var(--color-ink-muted)]">
                    Loading templates…
                  </div>
                ) : approvedTemplates.length === 0 ? (
                  <div className="mt-1 text-xs text-amber-400">
                    No approved WhatsApp templates found for this channel.
                  </div>
                ) : (
                  <select
                    id="dispatch-template"
                    value={activeTemplate?.id ?? ''}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    disabled={isSubmitting}
                    className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)]"
                  >
                    {approvedTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {activeTemplate && (
                <div>
                  <div className="text-[11px] font-medium text-[var(--color-ink-muted)]">
                    Body Preview:
                  </div>
                  <div className="mt-1 rounded bg-[var(--color-surface)] p-2 text-xs font-mono text-[var(--color-ink)] whitespace-pre-wrap">
                    {activeTemplate.body}
                  </div>
                </div>
              )}

              {activeTemplate && activeTemplate.variables.length > 0 && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-medium text-[var(--color-ink)]">
                    Template Variables
                  </div>
                  {activeTemplate.variables.map((variable) => (
                    <div key={variable} className="flex items-center gap-2">
                      <label
                        htmlFor={`dispatch-var-${variable}`}
                        className="w-24 text-[11px] font-mono text-[var(--color-ink-muted)] shrink-0"
                      >
                        {`{{${variable}}}`}:
                      </label>
                      <input
                        id={`dispatch-var-${variable}`}
                        type="text"
                        value={templateVariables[variable] ?? ''}
                        onChange={(e) => handleVariableChange(variable, e.target.value)}
                        placeholder={`Value for ${variable}`}
                        disabled={isSubmitting}
                        className="block w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Custom Text Mode (or SMS/RCS body) */}
          {(channelCode !== 'whatsapp' || sendMode === 'custom') && (
            <div>
              <label
                htmlFor="dispatch-text"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                {channelCode === 'sms'
                  ? 'SMS Body'
                  : channelCode === 'rcs'
                    ? 'RCS Message'
                    : 'Message Body'}
              </label>
              <textarea
                id="dispatch-text"
                rows={3}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Enter message content..."
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] resize-y"
              />
            </div>
          )}

          {/* SMS DLT Fields */}
          {channelCode === 'sms' && (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/30 p-3 space-y-2">
              <div className="text-xs font-medium text-[var(--color-ink)]">
                DLT Telecommunications Metadata (Optional / India Telecom)
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div>
                  <label
                    htmlFor="dlt-entity-id"
                    className="block text-[10px] text-[var(--color-ink-muted)]"
                  >
                    Entity ID
                  </label>
                  <input
                    id="dlt-entity-id"
                    type="text"
                    value={dltEntityId}
                    onChange={(e) => setDltEntityId(e.target.value)}
                    placeholder="1101…"
                    disabled={isSubmitting}
                    className="mt-0.5 block w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs text-[var(--color-ink)]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="dlt-template-id"
                    className="block text-[10px] text-[var(--color-ink-muted)]"
                  >
                    Template ID
                  </label>
                  <input
                    id="dlt-template-id"
                    type="text"
                    value={dltTemplateId}
                    onChange={(e) => setDltTemplateId(e.target.value)}
                    placeholder="1201…"
                    disabled={isSubmitting}
                    className="mt-0.5 block w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs text-[var(--color-ink)]"
                  />
                </div>
                <div>
                  <label
                    htmlFor="dlt-header-id"
                    className="block text-[10px] text-[var(--color-ink-muted)]"
                  >
                    Header ID
                  </label>
                  <input
                    id="dlt-header-id"
                    type="text"
                    value={dltHeaderId}
                    onChange={(e) => setDltHeaderId(e.target.value)}
                    placeholder="ALENDE"
                    disabled={isSubmitting}
                    className="mt-0.5 block w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 font-mono text-xs text-[var(--color-ink)]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !canSend}
              className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors shadow-xs"
            >
              {isSubmitting ? 'Dispatching…' : 'Send Message'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
