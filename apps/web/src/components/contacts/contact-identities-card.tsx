'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  channelsApi,
  contactsApi,
  type UpdateContactIdentityParams,
} from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ContactIdentityResponse, ContactResponse } from '@acc/contracts';

interface ContactIdentitiesCardProps {
  readonly contact: ContactResponse;
  readonly canManage?: boolean;
}

export function ContactIdentitiesCard({ contact, canManage = false }: ContactIdentitiesCardProps) {
  const queryClient = useQueryClient();

  // Load available channels
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
  });
  const channels = channelsData?.data ?? [];

  // Load identities for this contact
  const {
    data: identitiesData,
    isLoading,
    error: identitiesError,
  } = useQuery({
    queryKey: ['contacts', 'identities', contact.id],
    queryFn: ({ signal }) => contactsApi.listIdentities(contact.id, signal),
  });
  const identities = identitiesData?.data ?? [];

  const [isAdding, setIsAdding] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState('');
  const [rawAddress, setRawAddress] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    const effectiveChannelId = selectedChannelId || channels[0]?.id;
    if (!effectiveChannelId) {
      setError('Please select a communication channel.');
      return;
    }

    const trimmedAddress = rawAddress.trim();
    if (!trimmedAddress) {
      setError('Address or phone number is required.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await contactsApi.createIdentity(contact.id, {
        channelId: effectiveChannelId,
        rawAddress: trimmedAddress,
        isPrimary,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'identities', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'detail', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });

      toast.success('Identity Linked', `Channel address "${trimmedAddress}" attached.`);
      setRawAddress('');
      setIsPrimary(false);
      setIsAdding(false);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to add contact identity.');
      } else {
        setError('An unexpected error occurred while adding identity.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateIdentity = async (
    identityId: string,
    params: UpdateContactIdentityParams,
    successMsg: string,
  ) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await contactsApi.updateIdentity(identityId, params);
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'identities', contact.id] });
      toast.success('Identity Updated', successMsg);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to update identity.');
      } else {
        setError('An unexpected error occurred.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card
      className="border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs"
      data-testid="contact-identities-card"
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Communication Identities</CardTitle>
            <CardDescription>
              Registered channel endpoints, phone numbers, and destination addresses
            </CardDescription>
          </div>
          {canManage && !isAdding && (
            <button
              type="button"
              onClick={() => setIsAdding(true)}
              data-testid="add-identity-btn"
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)] transition-colors"
            >
              + Link Identity
            </button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-rose-500/20 bg-rose-500/10 p-2.5 text-xs text-rose-400"
          >
            {error}
          </div>
        )}

        {/* Add Identity Form */}
        {isAdding && (
          <form
            onSubmit={handleAddIdentity}
            className="rounded-lg border border-indigo-500/30 bg-indigo-500/5 p-3 text-xs space-y-3"
            data-testid="add-identity-form"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-indigo-400">Link Channel Identity</h4>
              <button
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setError(null);
                }}
                className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label
                  htmlFor="identity-channel-select"
                  className="block text-[11px] font-medium text-[var(--color-ink-muted)] mb-1"
                >
                  Communication Channel
                </label>
                <select
                  id="identity-channel-select"
                  value={selectedChannelId || channels[0]?.id || ''}
                  onChange={(e) => setSelectedChannelId(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName || c.code.toUpperCase()} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="identity-raw-address"
                  className="block text-[11px] font-medium text-[var(--color-ink-muted)] mb-1"
                >
                  Phone / Address
                </label>
                <input
                  id="identity-raw-address"
                  type="text"
                  value={rawAddress}
                  onChange={(e) => setRawAddress(e.target.value)}
                  disabled={isSubmitting}
                  placeholder="+12025550199 or user@domain.com"
                  className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="identity-set-primary"
                type="checkbox"
                checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
                disabled={isSubmitting}
                className="rounded border-[var(--color-border-subtle)]"
              />
              <label
                htmlFor="identity-set-primary"
                className="text-xs text-[var(--color-ink)] select-none"
              >
                Designate as primary identity for this channel
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setIsAdding(false)}
                disabled={isSubmitting}
                className="rounded px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !rawAddress.trim()}
                data-testid="submit-identity-btn"
                className="rounded bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Linking…' : 'Link Address'}
              </button>
            </div>
          </form>
        )}

        {/* Identities List */}
        {isLoading ? (
          <div role="status" className="py-6 text-center text-xs text-[var(--color-ink-muted)]">
            Loading identities…
          </div>
        ) : identitiesError ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-center text-xs text-rose-400"
          >
            Failed to load contact identities.
          </div>
        ) : identities.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
            No identities registered for this contact. Link a WhatsApp or SMS number to enable
            dispatches.
          </div>
        ) : (
          <div
            className="divide-y divide-[var(--color-border-subtle)] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]"
            data-testid="identities-list"
          >
            {identities.map((idnt: ContactIdentityResponse) => {
              const channel = channels.find((c) => c.id === idnt.channelId);
              const channelCode = channel?.code ?? 'generic';
              const channelName = channel?.displayName ?? channelCode.toUpperCase();

              return (
                <div
                  key={idnt.id}
                  data-testid={`identity-row-${idnt.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 p-3 text-xs"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-8 items-center justify-center rounded-md bg-[var(--color-surface)] border border-[var(--color-border-subtle)] font-mono text-[10px] uppercase font-bold text-[var(--color-ink)]">
                      {channelCode === 'whatsapp'
                        ? 'WA'
                        : channelCode === 'sms'
                          ? 'SMS'
                          : channelCode === 'rcs'
                            ? 'RCS'
                            : channelCode === 'email'
                              ? 'EML'
                              : 'CH'}
                    </div>

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-[var(--color-ink)]">
                          {idnt.normalizedAddress || idnt.rawAddress}
                        </span>
                        {idnt.isPrimary && (
                          <span
                            data-testid={`primary-badge-${idnt.id}`}
                            className="rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 font-mono text-[9px] uppercase font-bold tracking-wider"
                          >
                            Primary
                          </span>
                        )}
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                            idnt.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-zinc-500/10 text-zinc-400'
                          }`}
                        >
                          {idnt.status}
                        </span>
                      </div>
                      <p className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                        {channelName} • ID: {idnt.id.slice(0, 8)}…
                      </p>
                    </div>
                  </div>

                  {canManage && (
                    <div className="flex items-center gap-2">
                      {!idnt.isPrimary && idnt.status === 'active' && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() =>
                            handleUpdateIdentity(
                              idnt.id,
                              { isPrimary: true },
                              'Primary identifier updated.',
                            )
                          }
                          data-testid={`make-primary-btn-${idnt.id}`}
                          className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
                        >
                          Make Primary
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isSubmitting}
                        onClick={() =>
                          handleUpdateIdentity(
                            idnt.id,
                            { status: idnt.status === 'active' ? 'inactive' : 'active' },
                            `Identity marked ${idnt.status === 'active' ? 'inactive' : 'active'}.`,
                          )
                        }
                        data-testid={`toggle-status-btn-${idnt.id}`}
                        className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors"
                      >
                        {idnt.status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
