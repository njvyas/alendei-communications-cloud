'use client';

import { useHostnameBranding } from '@/lib/use-hostname-branding';

export function HostnameBrandingProvider() {
  useHostnameBranding();
  return null;
}
