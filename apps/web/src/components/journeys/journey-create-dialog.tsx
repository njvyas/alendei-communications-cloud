'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { journeysApi } from '@/lib/api-client';
import type { JourneyRecord } from '@/lib/journeys';
import { AccessibleDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

export interface JourneyCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly defaultWorkspaceId?: string;
  readonly onCreated?: (journey: JourneyRecord) => void;
}

export function JourneyCreateDialog({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId = '',
  onCreated,
}: JourneyCreateDialogProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || workspaces[0]?.id || '');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Stable Idempotency-Key per dialog session, preserved across network/validation retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const effectiveWorkspaceId = workspaceId || workspaces[0]?.id || '';

  const handleClose = () => {
    setName('');
    setDescription('');
    setErrorMessage(null);
    setIdempotencyKey(crypto.randomUUID());
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('Journey name is required.');
      return;
    }

    if (!effectiveWorkspaceId) {
      setErrorMessage('Please select a valid workspace.');
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await journeysApi.create(
        effectiveWorkspaceId,
        {
          name: trimmedName,
          description: description.trim() || undefined,
        },
        idempotencyKey,
      );

      toast.success(`Journey "${response.data.name}" created successfully.`);
      handleClose();

      if (onCreated) {
        onCreated(response.data);
      } else {
        router.push(`/journeys/${response.data.id}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create journey.';
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={open}
      onClose={handleClose}
      titleId="create-journey-title"
      maxWidth="max-w-lg"
      dismissible={!isSubmitting}
    >
      <div className="flex items-center justify-between border-b border-acc-border pb-4">
        <div>
          <h2
            id="create-journey-title"
            className="text-lg font-semibold tracking-tight text-acc-text-primary"
          >
            Create New Journey
          </h2>
          <p className="mt-1 text-xs text-acc-text-secondary">
            Initialize an automated communication flow with entry triggers, conditions, and actions.
          </p>
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-lg p-1.5 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary focus:outline-hidden focus:ring-2 focus:ring-acc-accent"
          aria-label="Close dialog"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400"
        >
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="journey-workspace"
            className="block text-xs font-semibold text-acc-text-secondary"
          >
            Workspace <span className="text-red-400">*</span>
          </label>
          <select
            id="journey-workspace"
            value={effectiveWorkspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            disabled={workspaces.length <= 1}
            className="mt-1 block w-full rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-2 text-sm text-acc-text-primary focus:border-acc-accent focus:outline-hidden focus:ring-1 focus:ring-acc-accent disabled:opacity-50"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="journey-name"
            className="block text-xs font-semibold text-acc-text-secondary"
          >
            Journey Name <span className="text-red-400">*</span>
          </label>
          <input
            id="journey-name"
            type="text"
            required
            maxLength={200}
            placeholder="e.g. User Onboarding Flow"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-2 text-sm text-acc-text-primary placeholder:text-acc-text-tertiary focus:border-acc-accent focus:outline-hidden focus:ring-1 focus:ring-acc-accent"
          />
        </div>

        <div>
          <label
            htmlFor="journey-description"
            className="block text-xs font-semibold text-acc-text-secondary"
          >
            Description (Optional)
          </label>
          <textarea
            id="journey-description"
            rows={3}
            maxLength={2000}
            placeholder="Provide context on triggers, audience targets, and multi-channel fallback strategies."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-acc-border bg-acc-surface-raised px-3 py-2 text-sm text-acc-text-primary placeholder:text-acc-text-tertiary focus:border-acc-accent focus:outline-hidden focus:ring-1 focus:ring-acc-accent"
          />
        </div>

        <div className="rounded-lg border border-acc-border/60 bg-acc-surface-raised/40 p-3 text-xs text-acc-text-secondary">
          <p className="font-medium text-acc-text-primary">Initial Graph</p>
          <p className="mt-0.5">
            The journey will be initialized with a standard trigger and exit structure ready for
            customization in the graph builder.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-acc-border">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-lg border border-acc-border px-4 py-2 text-xs font-medium text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary focus:outline-hidden"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting || !name.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-acc-accent px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-acc-accent-hover focus:outline-hidden disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Creating…
              </>
            ) : (
              'Create Journey'
            )}
          </button>
        </div>
      </form>
    </AccessibleDialog>
  );
}
