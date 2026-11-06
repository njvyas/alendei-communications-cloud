/**
 * Theme preference model (U15.1 specification §3).
 *
 * - The user preference (`system` | `light` | `dark`) is stored in the
 *   `acc_theme_preference` cookie; `system` is the default.
 * - The resolved theme (`light` | `dark`) is what is painted. Under `system` it
 *   follows `prefers-color-scheme`; it is cached in `acc_resolved_theme` so the
 *   server can render the right class on warm visits.
 * - Before first paint, `THEME_PRE_PAINT_SCRIPT` (nonce-authorised inline script)
 *   applies the resolved theme, so a cold visit never flashes the wrong theme.
 *
 * Pure and environment-free: used by the root layout (server), the pre-paint
 * script and the client theme store.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const THEME_PREFERENCE_COOKIE = 'acc_theme_preference';
export const RESOLVED_THEME_COOKIE = 'acc_resolved_theme';
/** One year, in seconds. */
export const THEME_COOKIE_MAX_AGE = 31_536_000;
export const DARK_CLASS = 'dark';
export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Anything other than an exact `light` or `dark` is the default `system`. */
export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** A resolved theme, or `null` when the value is not exactly `light` or `dark`. */
export function parseResolvedTheme(value: unknown): ResolvedTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

/**
 * The theme the server renders: explicit preferences exactly; under `system`, the
 * cached resolved theme when there is one, otherwise light (the pre-paint script
 * corrects a cold dark-mode visit before first paint).
 */
export function serverResolvedTheme(
  preferenceCookie: string | undefined,
  resolvedCookie: string | undefined,
): ResolvedTheme {
  const preference = parseThemePreference(preferenceCookie);
  if (preference !== 'system') return preference;
  return parseResolvedTheme(resolvedCookie) ?? 'light';
}

/** A `Set-Cookie`-style string for `document.cookie`. */
export function themeCookie(name: string, value: string, secure = false): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** Reads one cookie from a `document.cookie`-style string. */
export function readCookie(cookieString: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }
}

/**
 * Runs synchronously in <head> before first paint (authorised by the request's CSP
 * nonce). It must stay small, dependency-free and equivalent to `resolveTheme`:
 * an unknown preference is `system`; the resolved theme is cached for the server.
 * Any failure leaves the server-rendered class in place.
 */
export const THEME_PRE_PAINT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)${THEME_PREFERENCE_COOKIE}=([^;]*)/);var p=m?decodeURIComponent(m[1]):'system';if(p!=='light'&&p!=='dark'){p='system';}var d=p==='dark'||(p==='system'&&window.matchMedia('${DARK_MEDIA_QUERY}').matches);document.documentElement.classList.toggle('${DARK_CLASS}',d);document.cookie='${RESOLVED_THEME_COOKIE}='+(d?'dark':'light')+'; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');}catch(e){}})();`;
