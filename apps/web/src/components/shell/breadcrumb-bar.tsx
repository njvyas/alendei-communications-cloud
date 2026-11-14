'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { useSession, type AuthStatus } from '@/lib/session-store';
import {
  Breadcrumb,
  breadcrumbsFromPath,
  type BreadcrumbLinkProps,
} from '@/components/ui/breadcrumb';

const ROUTE_LABELS: Record<string, string> = {
  '/': 'Overview',
  '/messages': 'Messages',
  '/usage': 'Usage',
  '/whatsapp': 'WhatsApp',
  '/templates': 'Templates',
  '/campaigns': 'Campaigns',
  '/journeys': 'Journeys',
  '/contacts': 'Contacts',
  '/suppressions': 'Suppressions',
  '/channels': 'Channels',
  '/providers': 'Providers',
  '/resellers': 'Resellers',
  '/organizations': 'Organizations',
  '/domains': 'Domains',
  '/workspaces': 'Workspaces',
  '/teams': 'Teams',
  '/users': 'Users',
  '/roles': 'Roles',
  '/api-keys': 'API Keys',
  '/audit-logs': 'Audit Logs',
  '/support': 'Support & Ops',
};

export function BreadcrumbBar({
  status: propStatus,
  className,
}: {
  readonly status?: AuthStatus;
  readonly className?: string;
}) {
  const storeStatus = useSession((state) => state.status);
  const status = propStatus ?? storeStatus;
  const pathname = usePathname();
  let items = breadcrumbsFromPath(pathname, ROUTE_LABELS, 'Overview');

  if (status === 'zero_organizations') {
    items = items.map((item) => (item.href === '/' ? { label: item.label } : item));
  }

  return (
    <div
      className={cn(
        'border-b border-acc-border bg-acc-card/40 px-6 py-2.5 backdrop-blur-xs',
        className,
      )}
    >
      <Breadcrumb
        items={items}
        renderLink={({ href, title, className: linkClass, children }: BreadcrumbLinkProps) => (
          <Link href={href as Route} title={title} className={linkClass}>
            {children}
          </Link>
        )}
      />
    </div>
  );
}
