'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export interface AccessibleDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly titleId: string;
  readonly descriptionId?: string;
  readonly maxWidth?: string;
  readonly children?: ReactNode;
}

export function AccessibleDialog({
  isOpen,
  onClose,
  titleId,
  descriptionId,
  maxWidth = 'max-w-md',
  children,
}: AccessibleDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Focus preservation and escape listener
  useEffect(() => {
    if (!isOpen) return;

    // Record focused element before opening
    previousActiveElement.current = document.activeElement as HTMLElement | null;

    // Focus the dialog container
    const dialogElement = dialogRef.current;
    if (dialogElement) {
      const focusable = dialogElement.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const firstFocusable = focusable[0];
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        dialogElement.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === 'Tab' && dialogElement) {
        const focusable = Array.from(
          dialogElement.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );

        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (first && last) {
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      // Restore focus on close
      if (
        previousActiveElement.current &&
        typeof previousActiveElement.current.focus === 'function'
      ) {
        previousActiveElement.current.focus();
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`w-full ${maxWidth} rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-2xl focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
