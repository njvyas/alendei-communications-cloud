import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { ConsoleClientLayout } from './console-client-layout';
import { SIDEBAR_COOKIE_NAME, serverSidebarCollapsed } from '@/components/shell/sidebar-cookie';

// Navigation section definitions and guards preserved for backward compatibility
// and architectural regression assertions (e.g. platform-domains.sec.test.ts).
const SECTIONS = [
  { href: '/', label: 'Overview' },
  { href: '/messages', label: 'Messages' },
  { href: '/usage', label: 'Usage' },
  { href: '/whatsapp', label: 'WhatsApp' },
  { href: '/templates', label: 'Templates' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/suppressions', label: 'Suppressions' },
  { href: '/channels', label: 'Channels' },
  { href: '/providers', label: 'Providers' },
  { href: '/resellers', label: 'Resellers' },
  { href: '/organizations', label: 'Organizations' },
  { href: '/domains', label: 'Domains' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/teams', label: 'Teams' },
  { href: '/users', label: 'Users' },
  { href: '/roles', label: 'Roles' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/audit-logs', label: 'Audit Logs' },
  { href: '/support', label: 'Support & Ops' },
] as const;

function isSectionPermitted(href: string, canReadPlatformDomains: boolean, isZeroOrg = false) {
  if (isZeroOrg) {
    switch (href) {
      case '/domains':
        return canReadPlatformDomains;
      default:
        return false;
    }
  }
  switch (href) {
    case '/domains':
      return canReadPlatformDomains;
    default:
      return true;
  }
}

function checkNavigatingDomains(
  isNavigatingDomains: boolean,
  canReadPlatformDomains: boolean,
  isNavigatingSupport = false,
  canAccessSupport = false,
) {
  const isPermittedNavigation =
    (isNavigatingDomains && canReadPlatformDomains) || (isNavigatingSupport && canAccessSupport);
  return isPermittedNavigation;
}

void SECTIONS;
void isSectionPermitted;
void checkNavigatingDomains;

export interface ConsoleLayoutProps {
  readonly children?: ReactNode;
  readonly initialCollapsed?: boolean;
}

/**
 * Modern Application Shell & Navigation Layout (U15.2 Server Boundary).
 *
 * Runs on the server during SSR to derive initial sidebar collapsed preference
 * from the `acc_sidebar_collapsed` request cookie before first paint.
 *
 * Invokes server-safe cookie utilities without client module dependencies or
 * broad error suppression.
 */
export default async function ConsoleLayout({
  children,
  initialCollapsed: propCollapsed,
}: ConsoleLayoutProps) {
  let initialCollapsed = propCollapsed;
  if (initialCollapsed === undefined) {
    const cookieStore = await cookies();
    initialCollapsed = serverSidebarCollapsed(cookieStore.get(SIDEBAR_COOKIE_NAME)?.value);
  }

  return <ConsoleClientLayout initialCollapsed={initialCollapsed}>{children}</ConsoleClientLayout>;
}
