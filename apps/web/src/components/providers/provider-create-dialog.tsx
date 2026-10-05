'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, channelsApi, providersApi } from '@/lib/api-client';

interface ProviderCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultChannelId?: string;
}

export function ProviderCreateDialog({
  open,
  onOpenChange,
  defaultChannelId,
}: ProviderCreateDialogProps) {
  const queryClient = useQueryClient();

  const [channelId, setChannelId] = useState(defaultChannelId ?? '');
  const [name, setName] = useState('');
  const [adapterKey] = useState('simulator');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch available channels for dropdown
  const { data: channelsData, isLoading: isChannelsLoading } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50 }, signal),
    enabled: open,
  });

  const channels = channelsData?.data ?? [];

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedName = name.trim();
    if (!channelId) {
      setErrorMessage('Please select a communication channel.');
      return;
    }
    if (!trimmedName) {
      setErrorMessage('Provider name is required.');
      return;
    }
    if (trimmedName.length > 200) {
      setErrorMessage('Provider name cannot exceed 200 characters.');
      return;
    }

    setIsSubmitting(true);
    try {
      await providersApi.create({
        channelId,
        name: trimmedName,
        adapterKey,
      });

      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
      setName('');
      setChannelId(defaultChannelId ?? '');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('A provider with this name already exists for the selected channel.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to create provider. Please check your network connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Create Provider</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Providers are created in <strong>disabled</strong> status. An administrator must enable
          them before they carry traffic.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="create-provider-channel"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Channel <span className="text-[var(--color-bad,#ef4444)]">*</span>
            </label>
            <select
              id="create-provider-channel"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              disabled={isChannelsLoading || isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
              required
            >
              <option value="" disabled>
                {isChannelsLoading ? 'Loading channels…' : 'Select a channel…'}
              </option>
              {channels.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  {ch.displayName} ({ch.code})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="create-provider-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Provider Name <span className="text-[var(--color-bad,#ef4444)]">*</span>
            </label>
            <input
              id="create-provider-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Infobip Production WhatsApp"
              disabled={isSubmitting}
              maxLength={200}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
              required
            />
            <span className="mt-1 block text-[10px] text-[var(--color-ink-muted)]">
              Unique per channel. 1–200 characters, no surrounding whitespace.
            </span>
          </div>

          <div>
            <label
              htmlFor="create-provider-adapter"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Adapter Key
            </label>
            <input
              id="create-provider-adapter"
              type="text"
              value={adapterKey}
              readOnly
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-mono text-[var(--color-ink-muted)] shadow-xs cursor-not-allowed"
            />
            <span className="mt-1 block text-[10px] text-[var(--color-ink-muted)]">
              Phase 2 uses the built-in deterministic simulator adapter.
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !name.trim() || !channelId}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating…' : 'Create Provider'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
