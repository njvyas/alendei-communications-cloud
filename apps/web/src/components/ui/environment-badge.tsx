'use client';

import React from 'react';

export interface EnvironmentBadgeProps {
  readonly env?: string;
  readonly className?: string;
}

/**
 * Renders an environment indicator badge in the console header (U11).
 * Distinguishes QA, Staging, and Local Development from Production.
 * Does not render in production environments to avoid visual clutter.
 */
export function EnvironmentBadge(props: EnvironmentBadgeProps): React.ReactElement | null {
  const { env: envProp, className = '' } = props ?? {};
  const rawEnv = (envProp ?? process.env.NEXT_PUBLIC_APP_ENV ?? '').trim().toLowerCase();

  // Omit badge in production
  if (!rawEnv || rawEnv === 'production' || rawEnv === 'prod') {
    return null;
  }

  const isQa = rawEnv === 'qa';
  const isStaging = rawEnv === 'staging' || rawEnv === 'stage';
  const isDev = rawEnv === 'development' || rawEnv === 'dev' || rawEnv === 'local';

  const badgeStyle = isQa
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
    : isStaging
      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
      : isDev
        ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
        : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]';

  const label = isQa ? 'QA' : isStaging ? 'STAGING' : isDev ? 'DEV' : rawEnv.toUpperCase();

  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide uppercase ${badgeStyle} ${className}`}
      title={`Environment: ${rawEnv}`}
      data-testid="environment-badge"
    >
      {label}
    </span>
  );
}
