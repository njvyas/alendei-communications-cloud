'use client';

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';

import { listboxKeyIntent, typeaheadIndex } from './keyboard';

/**
 * Select (U15.1 specification §5.3): the WAI-ARIA "select-only combobox" pattern.
 *
 * Focus stays on the combobox; the active option is conveyed by
 * `aria-activedescendant`. Keys: ArrowDown/ArrowUp, Home/End, Enter/Space (select),
 * Escape (close without change), Tab (select the active option and move on), and
 * character type-ahead (open or closed). The listbox renders in a portal and flips
 * above the trigger or shrinks when the viewport has no room below.
 */

export interface SelectItem {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectGroup {
  readonly label: string;
  readonly items: readonly SelectItem[];
}

export type SelectOption = SelectItem | SelectGroup;

function isGroup(option: SelectOption): option is SelectGroup {
  return 'items' in option;
}

export function flattenOptions(options: readonly SelectOption[]): SelectItem[] {
  return options.flatMap((o) => (isGroup(o) ? [...o.items] : [o]));
}

export interface SelectProps {
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly options: readonly SelectOption[];
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly error?: ReactNode;
  readonly helperText?: ReactNode;
  readonly id?: string;
  readonly className?: string;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MAX_MENU_HEIGHT = 288;
const TYPEAHEAD_RESET_MS = 600;

interface MenuPosition {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly placement: 'bottom' | 'top';
}

/**
 * Collision handling: open below unless there is less room below than the menu
 * needs and more room above; constrain the height to the available space and keep
 * the menu inside the viewport horizontally.
 */
export function computeMenuPosition(
  trigger: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly width: number;
  },
  viewport: { readonly width: number; readonly height: number },
  desiredHeight: number,
): MenuPosition {
  const below = viewport.height - trigger.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const above = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
  const wanted = Math.min(desiredHeight, MAX_MENU_HEIGHT);
  const placement = below < wanted && above > below ? 'top' : 'bottom';
  const room = Math.max(placement === 'bottom' ? below : above, 0);
  const maxHeight = Math.max(Math.min(wanted, room), Math.min(wanted, 120));
  const width = Math.min(trigger.width, viewport.width - 2 * VIEWPORT_MARGIN);
  const left = Math.min(
    Math.max(trigger.left, VIEWPORT_MARGIN),
    viewport.width - VIEWPORT_MARGIN - width,
  );
  const top =
    placement === 'bottom'
      ? trigger.bottom + MENU_GAP
      : Math.max(trigger.top - MENU_GAP - maxHeight, VIEWPORT_MARGIN);
  return { top, left, width, maxHeight, placement };
}

function Chevron() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4 shrink-0 text-acc-text-secondary"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="m5 7.5 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
    >
      <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Select({
  label,
  hideLabel = false,
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  disabled = false,
  error,
  helperText,
  id,
  className,
}: SelectProps) {
  const generated = useId();
  const baseId = id ?? `select-${generated}`;
  const labelId = `${baseId}-label`;
  const listboxId = `${baseId}-listbox`;
  const errorId = error ? `${baseId}-error` : undefined;
  const helperId = helperText ? `${baseId}-helper` : undefined;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const items = useMemo(() => flattenOptions(options), [options]);
  const selectedIndex = items.findIndex((item) => item.value === value);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const typeahead = useRef<{ query: string; timer: ReturnType<typeof setTimeout> | null }>({
    query: '',
    timer: null,
  });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const desired = listRef.current?.scrollHeight ?? MAX_MENU_HEIGHT;
    setPosition(
      computeMenuPosition(rect, { width: window.innerWidth, height: window.innerHeight }, desired),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    // The listbox's own scrolling does not move the trigger.
    const reposition = (event?: Event) => {
      if (event?.target instanceof Node && listRef.current?.contains(event.target)) return;
      updatePosition();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => reposition();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, updatePosition]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document
      .getElementById(`${baseId}-option-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, baseId]);

  useEffect(
    () => () => {
      if (typeahead.current.timer) clearTimeout(typeahead.current.timer);
    },
    [],
  );

  const openMenu = (index: number) => {
    setActiveIndex(index);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setPosition(null);
  };
  const commit = (index: number) => {
    const item = items[index];
    if (item && !item.disabled) onValueChange(item.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const printable =
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey;
    if (printable || (event.key === ' ' && typeahead.current.query)) {
      event.preventDefault();
      const state = typeahead.current;
      state.query += event.key;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.query = '';
      }, TYPEAHEAD_RESET_MS);
      const from = open ? activeIndex : selectedIndex;
      const match = typeaheadIndex(items, state.query, from);
      if (match >= 0) {
        if (open) setActiveIndex(match);
        else onValueChange(items[match]!.value);
      }
      return;
    }
    const intent = listboxKeyIntent(event.key, items, open ? activeIndex : selectedIndex, open);
    switch (intent.type) {
      case 'open':
        event.preventDefault();
        openMenu(intent.index);
        break;
      case 'move':
        event.preventDefault();
        if (intent.index >= 0) setActiveIndex(intent.index);
        break;
      case 'select':
        event.preventDefault();
        commit(activeIndex);
        break;
      case 'close':
        if (event.key === 'Tab' && activeIndex >= 0) commit(activeIndex);
        else {
          event.preventDefault();
          close();
        }
        break;
      default:
        break;
    }
  };

  const describedBy = [errorId, helperId].filter(Boolean).join(' ') || undefined;
  let flatIndex = -1;

  const renderItem = (item: SelectItem) => {
    flatIndex += 1;
    const index = flatIndex;
    const isSelected = item.value === value;
    const isActive = index === activeIndex;
    return (
      <li
        key={item.value}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        aria-disabled={item.disabled || undefined}
        onPointerMove={() => !item.disabled && setActiveIndex(index)}
        onClick={() => {
          if (item.disabled) return;
          commit(index);
          triggerRef.current?.focus();
        }}
        className={cn(
          'flex cursor-default items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm text-acc-text-primary',
          isActive && 'bg-acc-primary-subtle outline-2 -outline-offset-2 outline-acc-primary',
          item.disabled && 'cursor-not-allowed text-acc-text-muted',
        )}
      >
        <span className="truncate">{item.label}</span>
        {isSelected && <Check />}
      </li>
    );
  };

  const menuStyle: CSSProperties | undefined = position
    ? {
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
      }
    : { visibility: 'hidden', top: 0, left: 0 };

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span
        id={labelId}
        className={cn('text-sm font-medium text-acc-text-primary', hideLabel && 'sr-only')}
      >
        {label}
      </span>
      <button
        ref={triggerRef}
        id={baseId}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu(selectedIndex >= 0 ? selectedIndex : -1))}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-[38px] w-full items-center justify-between gap-2 rounded-lg border bg-acc-card px-3 text-left text-sm',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary',
          'disabled:cursor-not-allowed disabled:bg-acc-surface-raised disabled:text-acc-text-muted',
          error
            ? 'border-acc-error shadow-[0_0_0_3px_var(--acc-error-subtle)]'
            : 'border-acc-border-input',
          selected ? 'text-acc-text-primary' : 'text-acc-text-secondary',
        )}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <Chevron />
      </button>
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-acc-error-text">
          {error}
        </p>
      )}
      {helperText && (
        <p id={helperId} className="text-xs text-acc-text-secondary">
          {helperText}
        </p>
      )}
      {open &&
        createPortal(
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-labelledby={labelId}
            tabIndex={-1}
            data-placement={position?.placement}
            style={menuStyle}
            className="fixed z-50 overflow-y-auto rounded-lg border border-acc-border bg-acc-card p-1 shadow-lg"
          >
            {options.map((option, groupIndex) =>
              isGroup(option) ? (
                <li key={`group-${groupIndex}`} role="presentation">
                  <ul role="group" aria-labelledby={`${baseId}-group-${groupIndex}`}>
                    <li
                      id={`${baseId}-group-${groupIndex}`}
                      role="presentation"
                      className="px-2.5 pt-2 pb-1 text-xs font-semibold text-acc-text-secondary"
                    >
                      {option.label}
                    </li>
                    {option.items.map(renderItem)}
                  </ul>
                </li>
              ) : (
                renderItem(option)
              ),
            )}
          </ul>,
          // Inside a modal, render within it so the options stay in the accessibility tree
          // (content outside an aria-modal dialog is treated as inert by assistive technology).
          triggerRef.current?.closest('[role="dialog"]') ?? document.body,
        )}
    </div>
  );
}
