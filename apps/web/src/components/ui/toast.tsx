'use client';

import React from 'react';
import { useToasts, toast, type ToastItem } from '@/lib/toast';

export function ToastContainer() {
  const items = useToasts();
  if (items.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-50 flex max-w-sm w-full flex-col gap-2 pointer-events-none p-2 sm:p-0"
      data-testid="toast-container"
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export function ToastCard({ item }: { readonly item: ToastItem }) {
  const isSuccess = item.type === 'success';
  const isError = item.type === 'error';

  const borderClass = isSuccess
    ? 'border-emerald-500/30'
    : isError
      ? 'border-rose-500/30'
      : 'border-sky-500/30';
  const dotClass = isSuccess ? 'bg-emerald-500' : isError ? 'bg-rose-500' : 'bg-sky-500';
  const titleClass = isSuccess ? 'text-emerald-400' : isError ? 'text-rose-400' : 'text-sky-400';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={`toast-${item.type}`}
      data-toast-id={item.id}
      className={`pointer-events-auto rounded-lg border ${borderClass} bg-[var(--color-surface)] p-3.5 shadow-lg text-xs transition-all`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
          <div className="space-y-0.5">
            <p className={`font-semibold ${titleClass}`}>{item.title}</p>
            {item.message && (
              <p className="text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
                {item.message}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => toast.dismiss(item.id)}
          aria-label="Dismiss notification"
          className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-current shrink-0"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
