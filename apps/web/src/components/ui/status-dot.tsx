import { cn } from '@/lib/cn';

export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown';

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn)]',
  bad: 'bg-[var(--color-bad)]',
  unknown: 'bg-[var(--color-ink-muted)]',
};

export function StatusDot({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        className={cn('size-2 rounded-full', TONE_CLASS[tone])}
        // The label carries the meaning for assistive tech; colour alone never does.
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
}
