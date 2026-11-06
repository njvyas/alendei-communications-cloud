'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { Drawer } from '@/components/ui/drawer';
import { IconClose } from './icons';
import { NAV_ITEMS, isNavItemVisible, type NavVisibilityContext, type NavGroupKey } from './types';

export interface MobileNavProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly navContext: NavVisibilityContext;
}

export function MobileNav({ isOpen, onClose, navContext }: MobileNavProps) {
  const pathname = usePathname();
  const visibleItems = NAV_ITEMS.filter((item) => isNavItemVisible(item.href, navContext));

  let currentGroup: NavGroupKey | null = null;

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      titleId="mobile-nav-title"
      side="left"
      width="max-w-xs"
    >
      {/* Brand header */}
      <div className="flex items-center justify-between border-b border-acc-border pb-4">
        <div>
          <h2 id="mobile-nav-title" className="text-base font-semibold text-acc-text-primary">
            Alendei
          </h2>
          <p className="text-xs text-acc-text-secondary">Control plane</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation menu"
          className="rounded p-1 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary"
        >
          <IconClose className="size-5" />
        </button>
      </div>

      {/* Navigation list */}
      <nav aria-label="Mobile Navigation" className="flex-1 overflow-y-auto py-4">
        <ul className="flex flex-col gap-1">
          {visibleItems.map((item) => {
            const isActive =
              item.href === '/'
                ? pathname === '/'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            const showGroupHeader = item.group !== currentGroup;
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
                  onClick={onClose}
                  className={cn(
                    'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-l-[3px] border-acc-primary bg-acc-primary-subtle text-acc-text-primary shadow-xs'
                      : 'border-l-[3px] border-transparent text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary',
                  )}
                >
                  <Icon
                    className={cn(
                      'size-4 shrink-0 transition-colors',
                      isActive ? 'text-acc-primary' : 'text-acc-text-secondary group-hover:text-acc-text-primary',
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </Drawer>
  );
}
