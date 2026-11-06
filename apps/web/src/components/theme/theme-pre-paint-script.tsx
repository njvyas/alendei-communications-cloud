import { THEME_PRE_PAINT_SCRIPT } from '@/lib/theme';

/**
 * The synchronous pre-paint theme script (U15.1 specification §3.2). Its content
 * is a compile-time constant (no user input). The nonce authorises it under the
 * CSP; browsers hide the nonce attribute after parsing, hence the hydration
 * warning suppression on this element only.
 */
export function ThemePrePaintScript({ nonce }: { readonly nonce?: string }) {
  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_PRE_PAINT_SCRIPT }}
    />
  );
}
