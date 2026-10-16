import type { TemplateApprovalStatus } from '@acc/contracts';
import { cn } from '@/lib/cn';

export function TemplateStatusBadge({ status }: { status: TemplateApprovalStatus }) {
  const styles: Record<TemplateApprovalStatus, { bg: string; dot: string; label: string }> = {
    draft: {
      bg: 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]',
      dot: 'bg-[var(--color-ink-muted)]',
      label: 'Draft',
    },
    pending: {
      bg: 'bg-[var(--color-warn-subtle,rgba(245,158,11,0.1))] text-[var(--color-warn,#f59e0b)] border border-amber-500/20',
      dot: 'bg-[var(--color-warn,#f59e0b)]',
      label: 'Pending (Simulated)',
    },
    approved: {
      bg: 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)] border border-emerald-500/20',
      dot: 'bg-[var(--color-ok,#10b981)]',
      label: 'Approved (Simulated)',
    },
    rejected: {
      bg: 'bg-[var(--color-danger-subtle,rgba(239,68,68,0.1))] text-[var(--color-danger,#ef4444)] border border-rose-500/20',
      dot: 'bg-[var(--color-danger,#ef4444)]',
      label: 'Rejected (Simulated)',
    },
  };

  const style = styles[status] ?? styles.draft;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        style.bg,
      )}
      data-testid="template-status-badge"
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{style.label}</span>
    </span>
  );
}
