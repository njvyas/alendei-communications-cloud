'use client';

import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import {
  attachModalKeyboard,
  focusInitialElement,
  modalDialogStack,
  restoreFocus,
  type DialogKeyOptions,
} from './dialog-focus';

export interface ModalOverlayProps {
  readonly tabIndex: -1;
}

export interface ModalDialogController {
  /** Attach to the dialog panel (with `tabIndex={-1}`) that contains the dialog's controls. */
  readonly panelRef: RefObject<HTMLDivElement | null>;
  /**
   * Props for the `role="dialog"` element; also records the current close handler
   * and whether dismissal is permitted. `tabIndex={-1}` lets a backdrop click keep
   * focus on the dialog rather than the page.
   */
  overlayProps(onDismiss: () => void, dismissible?: boolean): ModalOverlayProps;
}

/**
 * Modal focus management shared by `AccessibleDialog` and dialogs that render
 * their own overlay markup: initial focus, Tab/Shift+Tab containment, Escape
 * dismissal (when permitted) and focus restoration to the triggering element.
 *
 * Keyboard handling uses a single `document` keydown listener per open dialog,
 * so it applies even when focus has left the dialog. Only the most recently
 * opened dialog responds. The listener is removed on close and on unmount.
 *
 * Call it unconditionally (before any early `return null`) with whether the
 * dialog is currently rendered.
 */
export function useModalDialog(isOpen: boolean): ModalDialogController {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const keyOptionsRef = useRef<DialogKeyOptions>({ dismissible: true, onDismiss: () => {} });

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const detach = attachModalKeyboard({
      target: document,
      stack: modalDialogStack,
      getContainer: () => panelRef.current,
      getActiveElement: () => document.activeElement,
      getOptions: () => keyOptionsRef.current,
    });
    if (panelRef.current) focusInitialElement(panelRef.current);
    return () => {
      detach();
      restoreFocus(previous);
    };
  }, [isOpen]);

  const overlayProps = useCallback(
    (onDismiss: () => void, dismissible = true): ModalOverlayProps => {
      keyOptionsRef.current = { onDismiss, dismissible };
      return { tabIndex: -1 };
    },
    [],
  );

  return { panelRef, overlayProps };
}

export interface AccessibleDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly titleId: string;
  readonly descriptionId?: string;
  readonly maxWidth?: string;
  /** When false, Escape and backdrop clicks do not close the dialog (e.g. while saving). */
  readonly dismissible?: boolean;
  readonly children?: ReactNode;
}

export function AccessibleDialog({
  isOpen,
  onClose,
  titleId,
  descriptionId,
  maxWidth = 'max-w-md',
  dismissible = true,
  children,
}: AccessibleDialogProps) {
  const { panelRef, overlayProps } = useModalDialog(isOpen);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-in fade-in duration-150 focus:outline-none"
      {...overlayProps(onClose, dismissible)}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`w-full ${maxWidth} rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-2xl focus:outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
