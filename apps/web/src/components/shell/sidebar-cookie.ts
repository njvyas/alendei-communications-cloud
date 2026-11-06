/**
 * Shared server-safe cookie constants and parsing utilities for sidebar collapsed state.
 *
 * Security and Architecture Invariants:
 * 1. PURE UTILITY: This module contains NO `'use client'` directive and is 100% safe to
 *    import in React Server Components, Client Components, and isolated test harnesses.
 * 2. NO DOM ACCESS: Access to `document`, `window`, or client persistence is strictly
 *    forbidden in this module. Client cookie access must remain in client-side code.
 * 3. DETERMINISTIC: Parsing and serialization are pure functions without side effects.
 */

export const SIDEBAR_COOKIE_NAME = 'acc_sidebar_collapsed';
export const SIDEBAR_COOKIE_MAX_AGE = 31_536_000; // 1 year in seconds

/**
 * Parses the sidebar collapsed preference from a raw cookie string (e.g. `document.cookie` or cookie header).
 * Returns `true` for '1', `false` for '0', and `null` for absent or malformed values.
 */
export function parseSidebarCollapsedCookie(cookieString?: string | null): boolean | null {
  if (!cookieString) return null;
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE_NAME}=([01])`));
  if (!match) return null;
  return match[1] === '1';
}

/**
 * Resolves the initial sidebar collapsed state for server rendering.
 * Returns true if the cookie specifies '1', false for '0', missing, or invalid.
 * Accepts either bare cookie value ('1' | '0') or full cookie string ('acc_sidebar_collapsed=1').
 */
export function serverSidebarCollapsed(cookieValue?: string | null): boolean {
  if (!cookieValue) return false;
  if (cookieValue === '1') return true;
  if (cookieValue === '0') return false;
  return parseSidebarCollapsedCookie(cookieValue) ?? false;
}

/**
 * Builds a Set-Cookie style string for the sidebar collapsed preference.
 */
export function sidebarCookie(collapsed: boolean): string {
  return `${SIDEBAR_COOKIE_NAME}=${collapsed ? '1' : '0'}; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`;
}
