'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, templatesApi, type TargetApprovalStatus } from '@/lib/api-client';
import type { TemplateResponse } from '@acc/contracts';
import { TemplateStatusBadge } from './template-status-badge';
import { useModalDialog } from '@/components/ui/dialog';

interface TemplateApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: TemplateResponse | null;
}

export function TemplateApprovalDialog({
  open,
  onOpenChange,
  template,
}: TemplateApprovalDialogProps) {
  const queryClient = useQueryClient();

  const [targetStatus, setTargetStatus] = useState<TargetApprovalStatus>('approved');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modal = useModalDialog(open && !!template);

  if (!open || !template) return null;

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await templatesApi.simulateApproval(template.id, targetStatus);
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      handleClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code
            ? `${err.code}: ${err.message}`
            : err.message || 'Failed to update approval status.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while updating template approval status.');
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
      aria-labelledby="template-approval-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2
            id="template-approval-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Simulate Template Approval
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

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--color-ink)]">{template.name}</span>
              <TemplateStatusBadge status={template.approvalStatus} />
            </div>
            <p className="mt-2 line-clamp-2 text-xs font-mono text-[var(--color-ink-muted)]">
              {template.body}
            </p>
          </div>

          <div>
            <label
              htmlFor="target-status"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Simulated Target Status
            </label>
            <select
              id="target-status"
              value={targetStatus}
              onChange={(e) => setTargetStatus(e.target.value as TargetApprovalStatus)}
              disabled={isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              <option value="approved">APPROVED — Eligible for dispatch</option>
              <option value="pending">PENDING — Submission in review</option>
              <option value="rejected">REJECTED — Declined</option>
            </select>
          </div>

          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] text-[var(--color-ink-muted)]">
            <span className="font-semibold text-amber-500">Notice:</span> This is a simulated
            internal approval workflow for the test harness. No external network request is made to
            Meta WhatsApp API, and real WhatsApp template approval is not evaluated in Phase 3.
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
              {isSubmitting ? 'Updating…' : 'Apply State Change'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
