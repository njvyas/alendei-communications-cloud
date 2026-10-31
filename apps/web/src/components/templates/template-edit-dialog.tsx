'use client';

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, templatesApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useModalDialog } from '@/components/ui/dialog';
import type { TemplateResponse } from '@acc/contracts';

interface TemplateEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly template: TemplateResponse | null;
}

export function TemplateEditDialog({ open, onOpenChange, template }: TemplateEditDialogProps) {
  const queryClient = useQueryClient();

  const [name, setName] = useState(template?.name ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [variablesInput, setVariablesInput] = useState(
    template?.variables ? template.variables.join(', ') : '',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Sync state whenever open or template changes
  useEffect(() => {
    if (template && open) {
      setName(template.name ?? '');
      setBody(template.body ?? '');
      setVariablesInput(template.variables ? template.variables.join(', ') : '');
      setErrorMessage(null);
    }
  }, [template, open]);

  const modal = useModalDialog(open && Boolean(template));

  if (!open || !template) return null;

  const isApproved = template.approvalStatus === 'approved';

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (isApproved) {
      setErrorMessage('Approved templates cannot be modified directly.');
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
      const res = await templatesApi.update(template.id, {
        name: trimmedName,
        body: trimmedBody,
        variables: combinedVariables.length > 0 ? combinedVariables : undefined,
      });

      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template Updated', `Template "${res.data.name}" modified successfully.`);
      handleClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to update template.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while updating the template.');
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
      aria-labelledby="template-edit-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="template-edit-title" className="text-base font-semibold text-[var(--color-ink)]">
            Edit Message Template
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

        {isApproved && (
          <div
            className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-500"
            role="status"
          >
            <p className="font-semibold">Template is Approved</p>
            <p className="mt-1 text-[var(--color-ink-muted)]">
              Approved templates cannot be modified directly per carrier and channel regulations. To
              make changes, submit a new template or revision.
            </p>
          </div>
        )}

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
              htmlFor="edit-template-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Template Name
            </label>
            <input
              id="edit-template-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isApproved || isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              placeholder="e.g. order_shipped_notification"
            />
          </div>

          <div>
            <label
              htmlFor="edit-template-body"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Body Text
            </label>
            <textarea
              id="edit-template-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={isApproved || isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              placeholder="Hi {{name}}, your order {{order_id}} is on its way!"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              Parameters formatted like {'{{1}}'} or {'{{name}}'} will be automatically extracted.
            </p>
          </div>

          <div>
            <label
              htmlFor="edit-template-variables"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Variables (comma-separated, optional)
            </label>
            <input
              id="edit-template-variables"
              type="text"
              value={variablesInput}
              onChange={(e) => setVariablesInput(e.target.value)}
              disabled={isApproved || isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none disabled:opacity-50"
              placeholder="e.g. name, order_id"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-4">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              {isApproved ? 'Close' : 'Cancel'}
            </button>
            {!isApproved && (
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving…' : 'Save Changes'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
