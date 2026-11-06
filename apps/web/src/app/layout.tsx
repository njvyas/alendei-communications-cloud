import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import { ThemePrePaintScript } from '@/components/theme/theme-pre-paint-script';
import { ThemeSync } from '@/components/theme/theme-sync';
import { RESOLVED_THEME_COOKIE, THEME_PREFERENCE_COOKIE, serverResolvedTheme } from '@/lib/theme';
import { inter, geistMono } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alendei Communications Cloud',
  description: 'Control plane for Alendei Communications Cloud',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const theme = serverResolvedTheme(
    cookieStore.get(THEME_PREFERENCE_COOKIE)?.value,
    cookieStore.get(RESOLVED_THEME_COOKIE)?.value,
  );

  // `suppressHydrationWarning` covers only this element's `class`, which the
  // pre-paint script may correct before hydration (cold visit in OS dark mode).
  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : undefined} suppressHydrationWarning>
      <head>
        <ThemePrePaintScript nonce={nonce} />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} min-h-dvh antialiased font-sans`}>
        <ThemeSync />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
