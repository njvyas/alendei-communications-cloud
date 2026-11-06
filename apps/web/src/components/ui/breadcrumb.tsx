import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Breadcrumb navigation (U15.1 specification §5.7). `breadcrumbsFromPath` turns a
 * router pathname into items; long names and identifiers are truncated visually
 * (160px) with the full text kept in `title` and in the accessible name.
 */

export interface BreadcrumbItem {
  readonly label: string;
  /** Omitted for the current page. */
  readonly href?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function humanise(segment: string): string {
  if (UUID.test(segment)) return segment;
  const words = decodeURIComponent(segment).replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Items for a pathname. `labels` maps a segment (or a full path) to its display name;
 * route groups such as `(console)` are skipped. The last item has no link.
 */
export function breadcrumbsFromPath(
  pathname: string,
  labels: Readonly<Record<string, string>> = {},
  rootLabel = 'Home',
): BreadcrumbItem[] {
  const segments = pathname.split('/').filter((s) => s && !/^\(.*\)$/.test(s));
  const items: BreadcrumbItem[] = [{ label: rootLabel, href: '/' }];
  let path = '';
  segments.forEach((segment, index) => {
    path += `/${segment}`;
    const label = labels[path] ?? labels[segment] ?? humanise(segment);
    items.push(index === segments.length - 1 ? { label } : { label, href: path });
  });
  if (segments.length === 0) return [{ label: rootLabel }];
  return items;
}

export interface BreadcrumbLinkProps {
  readonly href: string;
  readonly title: string;
  readonly className: string;
  readonly children: ReactNode;
}

/** A plain anchor; the app shell can pass a client-side router link instead. */
function DefaultLink({ href, title, className, children }: BreadcrumbLinkProps) {
  return (
    <a href={href} title={title} className={className}>
      {children}
    </a>
  );
}

export function Breadcrumb({
  items,
  className,
  renderLink: LinkComponent = DefaultLink,
}: {
  readonly items: readonly BreadcrumbItem[];
  readonly className?: string;
  readonly renderLink?: (props: BreadcrumbLinkProps) => ReactNode;
}) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-sm', className)}>
      <ol className="flex flex-wrap items-center gap-1.5 text-acc-text-secondary">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${index}-${item.label}`} className="flex min-w-0 items-center gap-1.5">
              {item.href && !last ? (
                <LinkComponent
                  href={item.href}
                  title={item.label}
                  className="block max-w-[160px] truncate rounded-sm text-acc-text-secondary underline-offset-2 hover:text-acc-text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary"
                >
                  {item.label}
                </LinkComponent>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  title={item.label}
                  className="block max-w-[160px] truncate font-medium text-acc-text-primary"
                >
                  {item.label}
                </span>
              )}
              {!last && (
                <svg
                  viewBox="0 0 16 16"
                  className="size-3.5 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
