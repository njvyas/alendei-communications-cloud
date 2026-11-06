'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useState, useEffect, useRef } from 'react';

import { cn } from '@/lib/cn';
import { IconChevronLeft, IconChevronRight } from './icons';
import { NAV_ITEMS, isNavItemVisible, type NavVisibilityContext, type NavGroupKey } from './types';

export interface SidebarProps {
  readonly navContext: NavVisibilityContext;
  readonly defaultCollapsed?: boolean;
  readonly initialCollapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly className?: string;
}

import {
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_COOKIE_MAX_AGE,
  parseSidebarCollapsedCookie,
  serverSidebarCollapsed,
  sidebarCookie,
} from './sidebar-cookie';

export {
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_COOKIE_MAX_AGE,
  parseSidebarCollapsedCookie,
  serverSidebarCollapsed,
  sidebarCookie,
};

/**
 * Reads the sidebar collapsed preference from document.cookie in browser environments.
 * Returns null in SSR / Node.js or when the cookie is absent or invalid.
 */
export function readSidebarCollapsedCookie(): boolean | null {
  if (typeof document === 'undefined') return null;
  return parseSidebarCollapsedCookie(document.cookie);
}

/**
 * Writes the sidebar collapsed preference to document.cookie in browser environments.
 */
export function writeSidebarCollapsedCookie(collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  document.cookie = sidebarCookie(collapsed);
}

export function Sidebar({
  navContext,
  defaultCollapsed = false,
  initialCollapsed,
  onCollapsedChange,
  className,
}: SidebarProps) {
  const pathname = usePathname();
  // Saved preference determines initial rendered state with zero delayed useEffect or layout shift
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed ?? defaultCollapsed);
  const onCollapsedChangeRef = useRef(onCollapsedChange);

  useEffect(() => {
    onCollapsedChangeRef.current = onCollapsedChange;
  }, [onCollapsedChange]);

  const handleToggle = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    writeSidebarCollapsedCookie(next);
    onCollapsedChangeRef.current?.(next);
  };

  const visibleItems = NAV_ITEMS.filter((item) => isNavItemVisible(item.href, navContext));

  // Render items grouped by section
  let currentGroup: NavGroupKey | null = null;

  return (
    <aside
      aria-label="Sidebar"
      suppressHydrationWarning
      className={cn(
        'relative flex flex-col border-r border-acc-border bg-acc-sidebar text-acc-text-primary transition-all duration-200 select-none shrink-0',
        isCollapsed ? 'w-16' : 'w-60',
        className,
      )}
    >
      {/* Brand Header */}
      <div className="flex h-16 items-center justify-between border-b border-acc-border px-4">
        {isCollapsed ? (
          <div className="flex w-full items-center justify-center">
            <span
              className="font-mono text-sm font-bold tracking-tight text-acc-primary"
              title="Alendei Communications Cloud"
              aria-label="Alendei Communications Cloud"
            >
              <span aria-hidden="true">ACC</span>
              <span className="sr-only">Alendei Communications Cloud</span>
            </span>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-acc-text-primary">
              Alendei
            </p>
            <p className="truncate text-xs text-acc-text-secondary">Control plane</p>
          </div>
        )}
      </div>

      {/* Navigation Sections */}
      <nav aria-label="Sections" className="flex-1 overflow-y-auto px-2 py-3">
        <ul className="flex flex-col gap-1">
          {visibleItems.map((item) => {
            const isActive =
              item.href === '/'
                ? pathname === '/'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            const showGroupHeader = !isCollapsed && item.group !== currentGroup;
            if (showGroupHeader) {
              currentGroup = item.group;
            }

            const Icon = item.icon;

            return (
              <li key={item.href}>
                {showGroupHeader && (
                  <div className="mt-3 mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-acc-text-muted">
                    {item.groupLabel}
                  </div>
                )}
                <Link
                  href={item.href as Route}
                  aria-current={isActive ? 'page' : undefined}
                  aria-label={item.label}
                  title={isCollapsed ? item.label : undefined}
                  className={cn(
                    'group relative flex items-center rounded-md text-sm font-medium transition-colors',
                    isCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2',
                    isActive
                      ? 'border-l-[3px] border-acc-primary bg-acc-primary-subtle text-acc-text-primary shadow-xs'
                      : 'border-l-[3px] border-transparent text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary',
                  )}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'size-4 shrink-0 transition-colors',
                      isActive
                        ? 'text-acc-primary'
                        : 'text-acc-text-secondary group-hover:text-acc-text-primary',
                    )}
                  />
                  <span className={isCollapsed ? 'sr-only' : 'truncate'}>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse Toggle Footer */}
      <div className="border-t border-acc-border p-2">
        <button
          type="button"
          onClick={handleToggle}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!isCollapsed}
          className={cn(
            'flex w-full items-center rounded-md p-2 text-xs text-acc-text-secondary transition-colors hover:bg-acc-surface-raised hover:text-acc-text-primary',
            isCollapsed ? 'justify-center' : 'gap-2 px-3',
          )}
        >
          {isCollapsed ? (
            <>
              <IconChevronRight className="size-4 shrink-0" aria-hidden="true" />
              <span className="sr-only">Expand sidebar</span>
            </>
          ) : (
            <>
              <IconChevronLeft className="size-4 shrink-0" aria-hidden="true" />
              <span>Collapse sidebar</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
