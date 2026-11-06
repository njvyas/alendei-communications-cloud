'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

import { useModalDialog } from './dialog';

/**
 * Drawer (slide-over inspector panel). A modal dialog anchored to the side of the
 * viewport: it reuses the U10 modal focus management (`useModalDialog`: initial
 * focus, Tab containment, Escape when dismissible, focus restoration). The caller
 * provides the title element referenced by `titleId`.
 */
export interface DrawerProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly titleId: string;
  readonly descriptionId?: string;
  readonly side?: 'right' | 'left';
  /** Tailwind max-width class for the panel. */
  readonly width?: string;
  readonly dismissible?: boolean;
  readonly children?: ReactNode;
}

export function Drawer({
  isOpen,
  onClose,
  titleId,
  descriptionId,
  side = 'right',
  width = 'max-w-md',
  dismissible = true,
  children,
}: DrawerProps) {
  const { panelRef, overlayProps } = useModalDialog(isOpen);
  if (!isOpen) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        'fixed inset-0 z-50 flex bg-black/50 focus:outline-none',
        side === 'right' ? 'justify-end' : 'justify-start',
      )}
      {...overlayProps(onClose, dismissible)}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'flex h-full w-full flex-col overflow-y-auto border-acc-border bg-acc-card p-6 text-acc-text-primary shadow-2xl focus:outline-none',
          side === 'right' ? 'border-l' : 'border-r',
          width,
        )}
      >
        {children}
      </div>
    </div>
  );
}
