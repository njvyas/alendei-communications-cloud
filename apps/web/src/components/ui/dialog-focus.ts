/**
 * Framework-free focus management for modal dialogs (U10).
 *
 * The functions here hold the keyboard behaviour shared by `AccessibleDialog`
 * and `useModalDialog` so that it can be unit-tested without a browser DOM:
 *
 * - Tab / Shift+Tab wrap within the dialog and pull escaped focus back in.
 * - Escape dismisses the dialog only when dismissal is currently permitted
 *   (for example, not while a mutation is in flight).
 * - Focus returns to the element that was focused when the dialog opened.
 */

/** Elements that can receive keyboard focus inside a dialog. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Minimal element surface used by the focus helpers (satisfied by `HTMLElement`). */
export interface FocusableLike {
  focus(): void;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isConnected?: boolean;
}

/** Minimal container surface used by the focus helpers (satisfied by `HTMLElement`). */
export interface DialogContainerLike<T extends FocusableLike = FocusableLike> {
  querySelectorAll(selector: string): ArrayLike<T>;
  contains(node: unknown): boolean;
  focus(): void;
}

/** Minimal keyboard event surface (satisfied by DOM and React keyboard events). */
export interface DialogKeyEventLike {
  readonly key: string;
  readonly shiftKey: boolean;
  /** The element the key was dispatched to (DOM and React events provide it). */
  readonly target?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface DialogKeyOptions {
  /** Whether Escape may dismiss the dialog right now. */
  readonly dismissible: boolean;
  /** Called when the dialog should close. */
  readonly onDismiss: () => void;
}

export type DialogKeyOutcome =
  'dismissed' | 'dismiss-blocked' | 'deferred-to-native-popup' | 'focus-moved' | 'ignored';

/**
 * True when `node` is a native `<select>` whose picker is currently expanded,
 * detected with the standard `:open` pseudo-class. Some browsers (observed in
 * Firefox 155) deliver Escape to the page while the picker is open; that Escape
 * belongs to the picker, not to the dialog. Browsers without `:open` support
 * report false, which keeps the previous behaviour.
 */
export function isExpandedNativeSelect(node: unknown): boolean {
  const el = node as { tagName?: unknown; matches?: (selector: string) => boolean } | null;
  if (!el || typeof el.matches !== 'function') return false;
  if (typeof el.tagName !== 'string' || el.tagName.toUpperCase() !== 'SELECT') return false;
  try {
    return el.matches(':open');
  } catch {
    return false;
  }
}

function isAvailable(el: FocusableLike): boolean {
  return (
    !el.hasAttribute('disabled') &&
    el.getAttribute('aria-hidden') !== 'true' &&
    el.getAttribute('tabindex') !== '-1'
  );
}

/** Returns the focusable, enabled elements inside `container` in DOM order. */
export function getFocusableElements<T extends FocusableLike>(
  container: DialogContainerLike<T>,
): T[] {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isAvailable);
}

/**
 * Decides where Tab / Shift+Tab should move focus so that it stays inside the
 * dialog. Returns `null` when the browser's default movement already stays inside.
 */
export function resolveTabTarget<T>(
  focusables: readonly T[],
  active: unknown,
  shiftKey: boolean,
  activeInsideDialog: boolean,
): T | null {
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (first === undefined || last === undefined) return null;

  const index = focusables.indexOf(active as T);
  // Focus is on the container itself, on a non-tabbable node, or outside the
  // dialog entirely: bring it back to the appropriate end.
  if (index === -1 || !activeInsideDialog) {
    return shiftKey ? last : first;
  }
  if (shiftKey && index === 0) return last;
  if (!shiftKey && index === focusables.length - 1) return first;
  return null;
}

/**
 * Handles a keydown for an open modal dialog. Escape and Tab are always consumed
 * so that an enclosing dialog or page handler does not act on them as well.
 */
export function handleDialogKeyDown(
  event: DialogKeyEventLike,
  container: DialogContainerLike | null,
  activeElement: unknown,
  options: DialogKeyOptions,
): DialogKeyOutcome {
  if (event.key === 'Escape') {
    // Let the browser collapse an expanded native picker; do not close the dialog.
    if (isExpandedNativeSelect(event.target) || isExpandedNativeSelect(activeElement)) {
      return 'deferred-to-native-popup';
    }
    event.stopPropagation();
    if (!options.dismissible) {
      event.preventDefault();
      return 'dismiss-blocked';
    }
    event.preventDefault();
    options.onDismiss();
    return 'dismissed';
  }

  if (event.key !== 'Tab' || !container) return 'ignored';

  event.stopPropagation();
  const focusables = getFocusableElements(container);
  if (focusables.length === 0) {
    event.preventDefault();
    container.focus();
    return 'focus-moved';
  }

  const target = resolveTabTarget(
    focusables,
    activeElement,
    event.shiftKey,
    container.contains(activeElement),
  );
  if (!target) return 'ignored';

  event.preventDefault();
  target.focus();
  return 'focus-moved';
}

/**
 * Moves focus into a newly opened dialog: an element marked `data-autofocus`,
 * else the first focusable element, else the container itself.
 */
export function focusInitialElement(container: DialogContainerLike): void {
  const preferred = Array.from(container.querySelectorAll('[data-autofocus]')).find(isAvailable);
  const target = preferred ?? getFocusableElements(container)[0];
  if (target) {
    target.focus();
  } else {
    container.focus();
  }
}

/**
 * Ordered registry of open modal dialogs. Only the most recently opened dialog
 * (the top of the stack) acts on keyboard events, so a nested dialog closes on
 * Escape without also closing the dialog beneath it.
 */
export interface ModalDialogStack {
  push(token: object): void;
  remove(token: object): void;
  isTopmost(token: object): boolean;
  readonly size: number;
}

export function createDialogStack(): ModalDialogStack {
  const tokens: object[] = [];
  return {
    push(token) {
      tokens.push(token);
    },
    remove(token) {
      const index = tokens.lastIndexOf(token);
      if (index !== -1) tokens.splice(index, 1);
    },
    isTopmost(token) {
      return tokens.length > 0 && tokens[tokens.length - 1] === token;
    },
    get size() {
      return tokens.length;
    },
  };
}

/** Process-wide stack shared by every `useModalDialog` instance. */
export const modalDialogStack = createDialogStack();

/** Minimal event-target surface (satisfied by `document` and `window`). */
export interface KeydownTarget {
  addEventListener(type: 'keydown', listener: (event: DialogKeyEventLike) => void): void;
  removeEventListener(type: 'keydown', listener: (event: DialogKeyEventLike) => void): void;
}

export interface AttachModalKeyboardOptions {
  readonly target: KeydownTarget;
  readonly stack: ModalDialogStack;
  readonly getContainer: () => DialogContainerLike | null;
  readonly getActiveElement: () => unknown;
  /** Read on every keydown so the latest close handler and pending state apply. */
  readonly getOptions: () => DialogKeyOptions;
}

/**
 * Registers an open dialog on the stack and listens for keydown on a global
 * target, so Tab, Shift+Tab and Escape are handled even when focus has left
 * the dialog's DOM subtree. Returns a cleanup that removes both.
 */
export function attachModalKeyboard(options: AttachModalKeyboardOptions): () => void {
  const token = {};
  options.stack.push(token);
  const listener = (event: DialogKeyEventLike) => {
    if (!options.stack.isTopmost(token)) return;
    handleDialogKeyDown(
      event,
      options.getContainer(),
      options.getActiveElement(),
      options.getOptions(),
    );
  };
  options.target.addEventListener('keydown', listener);
  return () => {
    options.target.removeEventListener('keydown', listener);
    options.stack.remove(token);
  };
}

/** Returns focus to the element that opened the dialog, if it is still in the document. */
export function restoreFocus(previous: FocusableLike | null | undefined): boolean {
  if (!previous || typeof previous.focus !== 'function') return false;
  if (previous.isConnected === false) return false;
  previous.focus();
  return true;
}
