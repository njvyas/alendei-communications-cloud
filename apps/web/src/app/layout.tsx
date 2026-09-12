import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Alendei Communications Cloud',
  description: 'Control plane for Alendei Communications Cloud',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
