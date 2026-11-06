'use client';

import { useRef, type KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import { THEME_PREFERENCES, type ThemePreference } from '@/lib/theme';
import { useTheme } from '@/lib/theme-store';

import { rovingIndex } from './keyboard';

const LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * Theme preference selector (U15.1 specification §3.1): a WAI-ARIA radio group
 * (System / Light / Dark). Arrow keys move and select (roving tabindex); the choice
 * is stored in `acc_theme_preference` and applied immediately. Placement in the app
 * shell is U15.2.
 */
export function ThemePreferenceControl({ className }: { readonly className?: string }) {
  const { preference, setPreference } = useTheme();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const items = THEME_PREFERENCES.map((p) => ({ label: LABELS[p] }));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = THEME_PREFERENCES.indexOf(preference);
    const next = rovingIndex(event.key, items, current, 'both');
    if (next < 0) return;
    event.preventDefault();
    const choice = THEME_PREFERENCES[next]!;
    setPreference(choice);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex rounded-lg border border-acc-border-input bg-acc-card p-0.5',
        className,
      )}
    >
      {THEME_PREFERENCES.map((option, index) => {
        const checked = option === preference;
        return (
          <button
            key={option}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => setPreference(option)}
            className={cn(
              'h-8 rounded-md px-3 text-xs font-medium transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-primary',
              checked
                ? 'bg-acc-primary text-acc-on-primary'
                : 'text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary',
            )}
          >
            {LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
