/**
 * Content Security Policy for the console (U15.1 specification §3.2).
 *
 * Scripts run only with the per-request nonce (`'strict-dynamic'` lets those
 * scripts load the application chunks); there is no `'unsafe-inline'` for scripts.
 * `'unsafe-eval'` is added only in development, where React needs it for debugging.
 *
 * Styles allow `'unsafe-inline'`: React `style` props and Next.js development
 * styles are inline, and a nonce cannot authorise style attributes. Images allow
 * `https:` because organisation branding (logo, favicon) is an operator-supplied
 * HTTPS URL. API calls go to the configured API origin.
 */

export interface ContentSecurityPolicyOptions {
  readonly nonce: string;
  readonly isDevelopment: boolean;
  /** `NEXT_PUBLIC_API_BASE_URL`; its origin is allowed for `connect-src`. */
  readonly apiBaseUrl?: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{16,}$/;

/** The origin of an http(s) URL, or null when it is not one. */
export function apiOrigin(apiBaseUrl: string | undefined): string | null {
  if (!apiBaseUrl) return null;
  try {
    const url = new URL(apiBaseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  if (!NONCE_PATTERN.test(options.nonce)) {
    throw new Error('CSP nonce must be a base64 token of at least 16 characters');
  }
  const api = apiOrigin(options.apiBaseUrl);
  const connect = [
    "'self'",
    ...(api ? [api] : []),
    ...(options.isDevelopment ? ['ws:', 'wss:'] : []),
  ];
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    [
      'script-src',
      [
        "'self'",
        `'nonce-${options.nonce}'`,
        "'strict-dynamic'",
        ...(options.isDevelopment ? ["'unsafe-eval'"] : []),
      ],
    ],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connect],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/** A fresh nonce: 128 random bits, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
