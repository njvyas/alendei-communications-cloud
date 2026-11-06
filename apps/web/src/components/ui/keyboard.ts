/**
 * Pure keyboard-navigation helpers shared by Select (listbox), Tabs and the theme
 * radio group (WAI-ARIA Authoring Practices). Disabled items are skipped; an
 * index of -1 means "nothing to move to".
 */

export interface NavigableItem {
  readonly disabled?: boolean;
  readonly label: string;
}

/** The next enabled index from `from` in steps of `delta`; without `wrap` it stops at the ends. */
export function nextEnabledIndex(
  items: readonly NavigableItem[],
  from: number,
  delta: 1 | -1,
  wrap = false,
): number {
  const count = items.length;
  if (count === 0) return -1;
  let index = from;
  for (let step = 0; step < count; step += 1) {
    index += delta;
    if (index < 0 || index >= count) {
      if (!wrap) return from >= 0 && from < count && !items[from]?.disabled ? from : -1;
      index = (index + count) % count;
    }
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

export function firstEnabledIndex(items: readonly NavigableItem[]): number {
  return items.findIndex((item) => !item.disabled);
}

export function lastEnabledIndex(items: readonly NavigableItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (!items[i]?.disabled) return i;
  return -1;
}

/**
 * Type-ahead: the first enabled item whose label starts with `query`
 * (case-insensitive). A single character (or the same character repeated) searches
 * after the current item, so repeating a key cycles through matches; a longer
 * query keeps the current item if it still matches.
 */
export function typeaheadIndex(
  items: readonly NavigableItem[],
  query: string,
  from: number,
): number {
  const count = items.length;
  if (!query || count === 0) return -1;
  const q = query.toLocaleLowerCase();
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q.charAt(0) : q;
  const start = from < 0 ? 0 : from + (needle.length === 1 ? 1 : 0);
  for (let step = 0; step < count; step += 1) {
    const i = (start + step) % count;
    const item = items[i];
    if (item && !item.disabled && item.label.toLocaleLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

export type ListKeyIntent =
  | { readonly type: 'move'; readonly index: number }
  | { readonly type: 'select' }
  | { readonly type: 'close' }
  | { readonly type: 'open'; readonly index: number }
  | { readonly type: 'none' };

/** Key handling for a select-only combobox and its listbox (APG pattern). */
export function listboxKeyIntent(
  key: string,
  items: readonly NavigableItem[],
  activeIndex: number,
  isOpen: boolean,
): ListKeyIntent {
  if (!isOpen) {
    if (key === 'ArrowDown' || key === 'Enter' || key === ' ') {
      return { type: 'open', index: activeIndex >= 0 ? activeIndex : firstEnabledIndex(items) };
    }
    if (key === 'ArrowUp') {
      return { type: 'open', index: activeIndex >= 0 ? activeIndex : lastEnabledIndex(items) };
    }
    if (key === 'Home') return { type: 'open', index: firstEnabledIndex(items) };
    if (key === 'End') return { type: 'open', index: lastEnabledIndex(items) };
    return { type: 'none' };
  }
  switch (key) {
    case 'ArrowDown':
      return { type: 'move', index: nextEnabledIndex(items, activeIndex, 1) };
    case 'ArrowUp':
      return { type: 'move', index: nextEnabledIndex(items, activeIndex, -1) };
    case 'Home':
      return { type: 'move', index: firstEnabledIndex(items) };
    case 'End':
      return { type: 'move', index: lastEnabledIndex(items) };
    case 'Enter':
    case ' ':
      return { type: 'select' };
    case 'Escape':
    case 'Tab':
      return { type: 'close' };
    default:
      return { type: 'none' };
  }
}

/** Roving-focus key handling for tab lists and radio groups (wraps at the ends). */
export function rovingIndex(
  key: string,
  items: readonly NavigableItem[],
  current: number,
  orientation: 'horizontal' | 'both' = 'horizontal',
): number {
  const isNext = key === 'ArrowRight' || (orientation === 'both' && key === 'ArrowDown');
  const isPrev = key === 'ArrowLeft' || (orientation === 'both' && key === 'ArrowUp');
  if (isNext) return nextEnabledIndex(items, current, 1, true);
  if (isPrev) return nextEnabledIndex(items, current, -1, true);
  if (key === 'Home') return firstEnabledIndex(items);
  if (key === 'End') return lastEnabledIndex(items);
  return -1;
}
