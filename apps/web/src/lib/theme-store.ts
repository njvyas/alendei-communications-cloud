'use client';

import { useSyncExternalStore } from 'react';

import {
  DARK_CLASS,
  DARK_MEDIA_QUERY,
  RESOLVED_THEME_COOKIE,
  THEME_PREFERENCE_COOKIE,
  parseThemePreference,
  readCookie,
  resolveTheme,
  themeCookie,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';

/**
 * Client theme manager (U15.1 specification §3.3–3.4): reads and writes the
 * preference cookie, applies the resolved theme to <html>, and — while the
 * preference is `system` — follows operating-system changes without a reload.
 */

export interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
}

const SERVER_SNAPSHOT: ThemeSnapshot = { preference: 'system', resolved: 'light' };
const listeners = new Set<() => void>();
let current: ThemeSnapshot | null = null;
let mediaQuery: MediaQueryList | null = null;

function systemPrefersDark(): boolean {
  return mediaQuery?.matches ?? window.matchMedia(DARK_MEDIA_QUERY).matches;
}

function writeCookie(name: string, value: string): void {
  document.cookie = themeCookie(name, value, window.location.protocol === 'https:');
}

function apply(snapshot: ThemeSnapshot): void {
  document.documentElement.classList.toggle(DARK_CLASS, snapshot.resolved === 'dark');
  writeCookie(RESOLVED_THEME_COOKIE, snapshot.resolved);
  current = snapshot;
  for (const listener of listeners) listener();
}

function read(): ThemeSnapshot {
  const preference = parseThemePreference(readCookie(document.cookie, THEME_PREFERENCE_COOKIE));
  return { preference, resolved: resolveTheme(preference, systemPrefersDark()) };
}

function onSystemChange(event: MediaQueryListEvent): void {
  const snapshot = current ?? read();
  if (snapshot.preference !== 'system') return;
  apply({ preference: 'system', resolved: event.matches ? 'dark' : 'light' });
}

function ensureStarted(): void {
  if (mediaQuery || typeof window === 'undefined') return;
  mediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
  mediaQuery.addEventListener('change', onSystemChange);
  current = read();
}

/**
 * Starts following operating-system theme changes (idempotent) and makes the
 * <html> class match the resolved theme — a no-op when the pre-paint script ran,
 * a correction when it could not.
 */
export function startThemeSync(): void {
  ensureStarted();
  if (current) document.documentElement.classList.toggle(DARK_CLASS, current.resolved === 'dark');
}

export function getThemeSnapshot(): ThemeSnapshot {
  ensureStarted();
  return current ?? SERVER_SNAPSHOT;
}

export function subscribeTheme(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stores the preference and applies the resulting theme immediately. */
export function setThemePreference(preference: ThemePreference): void {
  ensureStarted();
  writeCookie(THEME_PREFERENCE_COOKIE, preference);
  apply({ preference, resolved: resolveTheme(preference, systemPrefersDark()) });
}

/** The current preference and resolved theme; `system`/`light` during server rendering. */
export function useTheme(): ThemeSnapshot & { setPreference: (p: ThemePreference) => void } {
  const snapshot = useSyncExternalStore(subscribeTheme, getThemeSnapshot, () => SERVER_SNAPSHOT);
  return { ...snapshot, setPreference: setThemePreference };
}
