import type { MessageStatus } from '@acc/contracts';
import { cn } from '@/lib/cn';

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const styles: Record<MessageStatus, { bg: string; dot: string; label: string }> = {
    queued: {
      bg: 'bg-sky-500/10 text-sky-400 border border-sky-500/20',
      dot: 'bg-sky-400',
      label: 'QUEUED',
    },
    routing: {
      bg: 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20',
      dot: 'bg-indigo-400',
      label: 'ROUTING',
    },
    submitting: {
      bg: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
      dot: 'bg-amber-400 animate-pulse',
      label: 'SUBMITTING',
    },
    accepted: {
      bg: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
      dot: 'bg-emerald-400',
      label: 'PROVIDER_ACCEPTED',
    },
    failed: {
      bg: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
      dot: 'bg-rose-400',
      label: 'FAILED',
    },
    outcome_unknown: {
      bg: 'bg-purple-500/10 text-purple-400 border border-purple-500/20',
      dot: 'bg-purple-400',
      label: 'OUTCOME_UNKNOWN',
    },
  };

  const style = styles[status] ?? styles.queued;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide',
        style.bg,
      )}
      data-testid="message-status-badge"
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{style.label}</span>
    </span>
  );
}
