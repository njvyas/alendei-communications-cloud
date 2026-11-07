import React from 'react';
import type { MessageDeliveryStatus } from '@/lib/api-client';
import { cn } from '@/lib/cn';

export interface DeliveryStatusBadgeProps {
  readonly deliveryStatus?: MessageDeliveryStatus | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
  readonly showTooltip?: boolean;
}

export function DeliveryStatusBadge({
  deliveryStatus,
  size = 'md',
  className,
  showTooltip = true,
}: DeliveryStatusBadgeProps) {
  const styles: Record<
    MessageDeliveryStatus | 'not_tracked',
    { bg: string; dot: string; label: string; description: string; ariaLabel: string }
  > = {
    pending: {
      bg: 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
      dot: 'bg-amber-400 animate-pulse',
      label: 'PENDING',
      description: 'Pending delivery confirmation from carrier or provider',
      ariaLabel: 'Delivery status: Pending delivery',
    },
    delivered: {
      bg: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
      dot: 'bg-emerald-400',
      label: 'DELIVERED',
      description: 'Confirmed positive delivery to recipient handset or carrier',
      ariaLabel: 'Delivery status: Delivered',
    },
    undelivered: {
      bg: 'bg-rose-500/10 text-rose-400 border border-rose-500/20',
      dot: 'bg-rose-400',
      label: 'UNDELIVERED',
      description: 'Final delivery failure reported by carrier or provider',
      ariaLabel: 'Delivery status: Undelivered',
    },
    not_supported: {
      bg: 'bg-zinc-500/10 text-zinc-400 border border-zinc-500/20',
      dot: 'bg-zinc-400',
      label: 'RECEIPTS N/A',
      description: 'Downstream delivery receipts not supported on this provider or channel',
      ariaLabel: 'Delivery status: Receipts not supported',
    },
    not_tracked: {
      bg: 'bg-slate-500/10 text-slate-400 border border-slate-500/20',
      dot: 'bg-slate-400',
      label: 'NOT TRACKED',
      description: 'Delivery outcome not tracked (legacy record or pre-submission failure)',
      ariaLabel: 'Delivery status: Not tracked',
    },
  };

  const key: MessageDeliveryStatus | 'not_tracked' =
    deliveryStatus && deliveryStatus in styles ? deliveryStatus : 'not_tracked';
  const style = styles[key];

  const sizeClasses =
    size === 'sm' ? 'px-2 py-0.5 text-[10px] gap-1' : 'px-2.5 py-0.5 text-xs gap-1.5';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold tracking-wide whitespace-nowrap',
        sizeClasses,
        style.bg,
        className,
      )}
      data-testid="delivery-status-badge"
      data-delivery-status={key}
      title={showTooltip ? style.description : undefined}
      aria-label={style.ariaLabel}
    >
      <span className={cn('size-1.5 rounded-full shrink-0', style.dot)} aria-hidden="true" />
      <span>{style.label}</span>
    </span>
  );
}

export interface ReadReceiptBadgeProps {
  readonly readAt?: string | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
  readonly showTooltip?: boolean;
}

export function ReadReceiptBadge({
  readAt,
  size = 'md',
  className,
  showTooltip = true,
}: ReadReceiptBadgeProps) {
  if (!readAt) return null;

  const formattedDate = new Date(readAt).toLocaleString();
  const description = `Read confirmed: ${formattedDate}`;

  const sizeClasses =
    size === 'sm' ? 'px-1.5 py-0.5 text-[10px] gap-1' : 'px-2 py-0.5 text-xs gap-1';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold tracking-wide bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 whitespace-nowrap',
        sizeClasses,
        className,
      )}
      data-testid="read-receipt-badge"
      title={showTooltip ? description : undefined}
      aria-label={`Read receipt: Confirmed at ${formattedDate}`}
    >
      <svg
        className="size-3 shrink-0 text-cyan-400"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 8.5l3.5 3.5 7.5-7.5" />
        <path d="M6 8.5l2 2 4.5-4.5" />
      </svg>
      <span>READ</span>
    </span>
  );
}

export interface DeliveryOutcomeCellProps {
  readonly deliveryStatus?: MessageDeliveryStatus | null;
  readonly readAt?: string | null;
  readonly deliveredAt?: string | null;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

export function DeliveryOutcomeCell({
  deliveryStatus,
  readAt,
  deliveredAt,
  size = 'sm',
  className,
}: DeliveryOutcomeCellProps) {
  return (
    <div
      className={cn('inline-flex flex-col gap-1 items-start', className)}
      data-testid="delivery-outcome-cell"
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <DeliveryStatusBadge deliveryStatus={deliveryStatus} size={size} />
        {readAt && <ReadReceiptBadge readAt={readAt} size={size} />}
      </div>
      {deliveredAt && (
        <span
          className="text-[10px] text-[var(--color-ink-muted)] font-mono"
          title={`Delivered at: ${new Date(deliveredAt).toLocaleString()}`}
        >
          {new Date(deliveredAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}
