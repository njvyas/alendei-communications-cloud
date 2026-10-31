'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, templatesApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useModalDialog } from '@/components/ui/dialog';
import type { TemplateResponse } from '@acc/contracts';

interface TemplateDeleteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly template: TemplateResponse | null;
}

export function TemplateDeleteDialog({ open, onOpenChange, template }: TemplateDeleteDialogProps) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modal = useModalDialog(open && Boolean(template));

  if (!open || !template) return null;

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleDelete = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await templatesApi.delete(template.id);
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template Deleted', `Template "${template.name}" removed successfully.`);
      handleClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to delete template.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while deleting the template.');
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
      aria-labelledby="template-delete-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2
            id="template-delete-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Delete Message Template
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

        <div className="mt-4 space-y-3">
          {errorMessage && (
            <div
              className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400"
              role="alert"
            >
              {errorMessage}
            </div>
          )}

          <p className="text-xs text-[var(--color-ink)]">
            Are you sure you want to delete message template{' '}
            <strong className="font-semibold text-[var(--color-ink)]">{template.name}</strong>?
          </p>

          <p className="text-xs text-[var(--color-ink-muted)]">
            This action will soft-delete the template from your organization catalogue. Dispatches
            targeting this template ID will no longer be admitted.
          </p>

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-[11px] text-[var(--color-ink-muted)] space-y-1">
            <div>
              <span className="font-medium text-[var(--color-ink)]">Template ID: </span>
              <code className="font-mono text-[10px]">{template.id}</code>
            </div>
            <div>
              <span className="font-medium text-[var(--color-ink)]">Approval Status: </span>
              <span className="capitalize">{template.approvalStatus}</span>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-4">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={isSubmitting}
            data-testid="confirm-delete-template-btn"
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Deleting…' : 'Delete Template'}
          </button>
        </div>
      </div>
    </div>
  );
}
