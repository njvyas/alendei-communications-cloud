'use client';

import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import {
  CHALLENGE_STATE_LABELS,
  CHALLENGE_STATE_TONES,
  type DomainChallengeState,
  type Tone,
} from '@/lib/platform-domains';

export const TONE_TO_STATUS: Record<Tone, StatusTone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  neutral: 'unknown',
};

export function ChallengeBadge({ state }: { readonly state: DomainChallengeState }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-ink)]"
      data-testid={`challenge-${state}`}
    >
      <StatusDot
        tone={TONE_TO_STATUS[CHALLENGE_STATE_TONES[state]]}
        label={CHALLENGE_STATE_LABELS[state]}
      />
    </span>
  );
}
