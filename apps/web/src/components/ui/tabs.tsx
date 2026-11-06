'use client';

import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/cn';

import { rovingIndex } from './keyboard';

/**
 * Tabs (U15.1 specification §5.6): WAI-ARIA Tabs with automatic activation.
 * `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`,
 * `aria-controls` / `aria-labelledby`; only the selected tab is in the tab order;
 * ArrowLeft/ArrowRight move and select (wrapping), Home/End jump; disabled tabs are
 * skipped. The active tab has a 2px primary indicator (non-text contrast >= 3:1).
 */

interface TabsContextValue {
  readonly baseId: string;
  readonly value: string;
  /** The tab that is in the tab order: the selected one, or the first enabled tab if none matches. */
  readonly focusValue: string;
  readonly select: (value: string) => void;
  readonly register: (value: string, disabled: boolean) => () => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`${component} must be used inside <Tabs>`);
  return ctx;
}

/** An id-safe, collision-free encoding of a tab value. */
const slug = (value: string) =>
  value.replace(/[^A-Za-z0-9]/g, (c) => `_${c.codePointAt(0)!.toString(16)}_`);

export interface TabsProps {
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Tabs({ value, defaultValue = '', onValueChange, className, children }: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue);
  const [registered, setRegistered] = useState<ReadonlyArray<{ value: string; disabled: boolean }>>(
    [],
  );
  const current = value ?? internal;
  const select = (next: string) => {
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  };
  const register = useCallback((v: string, disabled: boolean) => {
    setRegistered((list) => [...list.filter((t) => t.value !== v), { value: v, disabled }]);
    return () => setRegistered((list) => list.filter((t) => t.value !== v));
  }, []);
  const matches = registered.some((t) => t.value === current && !t.disabled);
  const focusValue = matches ? current : (registered.find((t) => !t.disabled)?.value ?? current);
  return (
    <TabsContext.Provider value={{ baseId, value: current, focusValue, select, register }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  label,
  className,
  children,
}: {
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current < 0) return;
    const items = tabs.map((tab) => ({ label: tab.textContent ?? '', disabled: tab.disabled }));
    const next = rovingIndex(event.key, items, current);
    if (next < 0 || next === current) return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn('flex gap-1 border-b border-acc-border', className)}
    >
      {children}
    </div>
  );
}

export function TabsTrigger({
  value,
  disabled = false,
  className,
  children,
}: {
  readonly value: string;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { baseId, value: selectedValue, focusValue, select, register } = useTabs('TabsTrigger');
  const selected = value === selectedValue;
  useLayoutEffect(() => register(value, disabled), [register, value, disabled]);
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${slug(value)}`}
      aria-selected={selected}
      aria-controls={`${baseId}-panel-${slug(value)}`}
      tabIndex={value === focusValue ? 0 : -1}
      disabled={disabled}
      onClick={() => select(value)}
      className={cn(
        '-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-acc-primary',
        selected
          ? 'border-acc-primary text-acc-text-primary'
          : 'border-transparent text-acc-text-secondary hover:text-acc-text-primary',
        'disabled:cursor-not-allowed disabled:text-acc-text-muted',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  readonly value: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { baseId, value: selectedValue } = useTabs('TabsContent');
  const selected = value === selectedValue;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${slug(value)}`}
      aria-labelledby={`${baseId}-tab-${slug(value)}`}
      hidden={!selected}
      tabIndex={0}
      className={cn(
        'mt-4 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary',
        className,
      )}
    >
      {selected ? children : null}
    </div>
  );
}
