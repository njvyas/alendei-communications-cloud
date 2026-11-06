'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';

import { cn } from '@/lib/cn';
import { IconChevronLeft, IconChevronRight } from './icons';
import { NAV_ITEMS, isNavItemVisible, type NavVisibilityContext, type NavGroupKey } from './types';

export interface SidebarProps {
  readonly navContext: NavVisibilityContext;
  readonly defaultCollapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  readonly className?: string;
}

const SIDEBAR_COOKIE_NAME = 'acc_sidebar_collapsed';

export function Sidebar({
  navContext,
  defaultCollapsed = false,
  onCollapsedChange,
  className,
}: SidebarProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  // Sync from cookie on mount if available
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${SIDEBAR_COOKIE_NAME}=([01])`));
      if (match) {
        const val = match[1] === '1';
        setIsCollapsed(val);
        onCollapsedChange?.(val);
      }
    }
  }, [onCollapsedChange]);

  const handleToggle = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      if (typeof document !== 'undefined') {
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${next ? '1' : '0'}; Path=/; SameSite=Lax; Max-Age=31536000`;
      }
      onCollapsedChange?.(next);
      return next;
    });
  };

  const visibleItems = NAV_ITEMS.filter((item) => isNavItemVisible(item.href, navContext));

  // Render items grouped by section
  let currentGroup: NavGroupKey | null = null;

  return (
    <aside
      aria-label="Sidebar"
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
            >
              ACC
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
                    className={cn(
                      'size-4 shrink-0 transition-colors',
                      isActive
                        ? 'text-acc-primary'
                        : 'text-acc-text-secondary group-hover:text-acc-text-primary',
                    )}
                  />
                  {!isCollapsed && <span className="truncate">{item.label}</span>}
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
          className={cn(
            'flex w-full items-center rounded-md p-2 text-xs text-acc-text-secondary transition-colors hover:bg-acc-surface-raised hover:text-acc-text-primary',
            isCollapsed ? 'justify-center' : 'gap-2 px-3',
          )}
        >
          {isCollapsed ? (
            <IconChevronRight className="size-4 shrink-0" />
          ) : (
            <>
              <IconChevronLeft className="size-4 shrink-0" />
              <span>Collapse sidebar</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
