import type {
  ChannelStatus,
  ProviderCircuitState,
  ProviderHealthState,
  ProviderStatus,
} from '@acc/contracts';
import { cn } from '@/lib/cn';

export function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  const isOk = status === 'active';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        isOk
          ? 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]'
          : 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          isOk ? 'bg-[var(--color-ok,#10b981)]' : 'bg-[var(--color-ink-muted)]',
        )}
        aria-hidden="true"
      />
      <span className="capitalize">{status}</span>
    </span>
  );
}

export function ProviderLifecycleBadge({ status }: { status: ProviderStatus }) {
  const styles: Record<ProviderStatus, { bg: string; dot: string }> = {
    active: {
      bg: 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]',
      dot: 'bg-[var(--color-ok,#10b981)]',
    },
    draining: {
      bg: 'bg-[var(--color-warn-subtle,rgba(245,158,11,0.1))] text-[var(--color-warn,#f59e0b)]',
      dot: 'bg-[var(--color-warn,#f59e0b)]',
    },
    disabled: {
      bg: 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]',
      dot: 'bg-[var(--color-ink-muted)]',
    },
  };

  const style = styles[status] ?? styles.disabled;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wider',
        style.bg,
      )}
      data-testid="provider-lifecycle-badge"
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export function ProviderHealthBadge({
  healthState,
  healthOverride,
}: {
  healthState: ProviderHealthState;
  healthOverride?: ProviderHealthState | null;
}) {
  const styles: Record<ProviderHealthState, { bg: string; dot: string }> = {
    healthy: {
      bg: 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]',
      dot: 'bg-[var(--color-ok,#10b981)]',
    },
    degraded: {
      bg: 'bg-[var(--color-warn-subtle,rgba(245,158,11,0.1))] text-[var(--color-warn,#f59e0b)]',
      dot: 'bg-[var(--color-warn,#f59e0b)]',
    },
    critical: {
      bg: 'bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-[var(--color-bad,#ef4444)]',
      dot: 'bg-[var(--color-bad,#ef4444)]',
    },
    offline: {
      bg: 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]',
      dot: 'bg-[var(--color-ink-muted)]',
    },
  };

  const style = styles[healthState] ?? styles.offline;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        style.bg,
      )}
      data-testid="provider-health-badge"
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{healthState}</span>
      {healthOverride !== undefined && healthOverride !== null && (
        <span
          data-testid="provider-health-pin"
          className="ml-0.5 rounded px-1 text-[10px] uppercase font-mono bg-black/10 dark:bg-white/10"
          title={`Manually overridden to ${healthOverride}`}
        >
          PIN
        </span>
      )}
    </span>
  );
}

export function ProviderCircuitBadge({
  circuitState,
  cooldownUntil,
}: {
  circuitState: ProviderCircuitState;
  cooldownUntil?: string | null;
}) {
  const styles: Record<ProviderCircuitState, { bg: string; dot: string; label: string }> = {
    closed: {
      bg: 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]',
      dot: 'bg-[var(--color-ok,#10b981)]',
      label: 'Closed',
    },
    half_open: {
      bg: 'bg-[var(--color-warn-subtle,rgba(245,158,11,0.1))] text-[var(--color-warn,#f59e0b)]',
      dot: 'bg-[var(--color-warn,#f59e0b)]',
      label: 'Half Open',
    },
    open: {
      bg: 'bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-[var(--color-bad,#ef4444)]',
      dot: 'bg-[var(--color-bad,#ef4444)]',
      label: 'Open',
    },
  };

  const style = styles[circuitState] ?? styles.closed;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        style.bg,
      )}
      data-testid="provider-circuit-badge"
    >
      <span className={cn('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      <span>{style.label}</span>
      {circuitState === 'open' && cooldownUntil && (
        <span
          className="ml-0.5 text-[10px] font-mono text-[var(--color-ink-muted)]"
          title={`Cooldown ends at ${cooldownUntil}`}
        >
          (cooling)
        </span>
      )}
    </span>
  );
}
