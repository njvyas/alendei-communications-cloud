'use client';

import { useEffect, useState } from 'react';
import { domainsApi, type ResolvedDomainView } from './api-client';

export function useHostnameBranding() {
  const [resolution, setResolution] = useState<ResolvedDomainView | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hostname = window.location.hostname;
    const controller = new AbortController();

    domainsApi
      .resolve(hostname, controller.signal)
      .then((res) => {
        const resolved = res.data;
        setResolution(resolved);

        if (resolved.branding) {
          if (resolved.branding.brandName) {
            document.title = `${resolved.branding.brandName} Console`;
          }

          if (resolved.branding.faviconUrl) {
            let link = document.querySelector("link[rel*='icon']") as HTMLLinkElement | null;
            if (!link) {
              link = document.createElement('link');
              link.rel = 'shortcut icon';
              document.getElementsByTagName('head')[0]?.appendChild(link);
            }
            link.href = resolved.branding.faviconUrl;
          }

          if (resolved.branding.primaryColor) {
            document.documentElement.style.setProperty(
              '--color-brand-primary',
              resolved.branding.primaryColor,
            );
          }

          if (resolved.branding.accentColor) {
            document.documentElement.style.setProperty(
              '--color-brand-accent',
              resolved.branding.accentColor,
            );
          }
        }
      })
      .catch(() => {
        // Fallback silently to platform defaults; never break navigation
      })
      .finally(() => {
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, []);

  return { resolution, isLoading };
}
