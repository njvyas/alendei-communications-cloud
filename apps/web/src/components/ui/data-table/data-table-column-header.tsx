'use client';

import { cn } from '@/lib/cn';

import type { DataTableColumn, DataTableQueryState } from './types';

/** The next server sort for a header activation: ascending first, then toggling. */
export function nextSort(
  column: { readonly sortField?: string },
  query: Pick<DataTableQueryState, 'sortField' | 'sortDirection'>,
): Pick<DataTableQueryState, 'sortField' | 'sortDirection'> | null {
  if (!column.sortField) return null;
  if (query.sortField !== column.sortField)
    return { sortField: column.sortField, sortDirection: 'asc' };
  return {
    sortField: column.sortField,
    sortDirection: query.sortDirection === 'asc' ? 'desc' : 'asc',
  };
}

export function ariaSort(
  column: { readonly sortField?: string },
  query: Pick<DataTableQueryState, 'sortField' | 'sortDirection'>,
): 'ascending' | 'descending' | 'none' | undefined {
  if (!column.sortField) return undefined;
  if (query.sortField !== column.sortField) return 'none';
  return query.sortDirection === 'desc' ? 'descending' : 'ascending';
}

function SortIcon({ state }: { readonly state: 'ascending' | 'descending' | 'none' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path
        d="m5 6 3-3 3 3"
        className={cn(state === 'descending' && 'opacity-30')}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m5 10 3 3 3-3"
        className={cn(state === 'ascending' && 'opacity-30')}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DataTableColumnHeader<TData>({
  column,
  queryState,
  onQueryChange,
}: {
  readonly column: DataTableColumn<TData>;
  readonly queryState: DataTableQueryState;
  readonly onQueryChange: (state: Partial<DataTableQueryState>) => void;
}) {
  const sort = ariaSort(column, queryState);
  const align =
    column.align === 'right'
      ? 'text-right'
      : column.align === 'center'
        ? 'text-center'
        : 'text-left';
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cn('px-4 py-2.5 text-xs font-semibold text-acc-text-primary', align, column.width)}
    >
      {sort ? (
        <button
          type="button"
          onClick={() => {
            const next = nextSort(column, queryState);
            // A new sort starts from the first page: cursors belong to the old order.
            if (next) onQueryChange({ ...next, cursor: undefined, page: 1 });
          }}
          className="inline-flex items-center gap-1 rounded-sm hover:text-acc-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary"
        >
          {column.header}
          <SortIcon state={sort} />
        </button>
      ) : (
        column.header
      )}
    </th>
  );
}
