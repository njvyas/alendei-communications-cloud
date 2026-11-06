'use client';

import { useEffect } from 'react';

import { startThemeSync } from '@/lib/theme-store';

/**
 * Mounted once in the root layout: while the preference is `system`, the page
 * follows operating-system theme changes without a reload (U15.1 specification §3.4).
 * Renders nothing.
 */
export function ThemeSync() {
  useEffect(() => startThemeSync(), []);
  return null;
}
