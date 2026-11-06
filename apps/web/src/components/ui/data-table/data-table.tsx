'use client';

import type { KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';

import { DataTableColumnHeader } from './data-table-column-header';
import { DataTableEmpty } from './data-table-empty';
import { DataTablePagination } from './data-table-pagination';
import { DataTableSkeleton } from './data-table-skeleton';
import type { DataTableProps } from './types';

const INNER_CONTROLS =
  'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="combobox"],[tabindex]:not([tabindex="-1"])';

/**
 * DataTable (U15.1 specification §4): renders exactly the rows it is given, in the
 * order given. Sorting and pagination are emitted through `onQueryChange`; tenant
 * scope and authorisation stay with the API request the caller makes. There is no
 * client-side filtering or sorting of a page of results.
 */
export function DataTable<TData>({
  caption,
  columns,
  data,
  getRowKey,
  totalCount,
  hasNextPage,
  hasPreviousPage,
  nextCursor,
  previousCursor,
  isLoading,
  isFetching = false,
  error,
  queryState,
  onQueryChange,
  emptyState,
  onRowClick,
  rowActionLabel = () => 'Open row',
}: DataTableProps<TData>) {
  const busy = isLoading || isFetching;
  // Keys and clicks on controls inside a cell (buttons, links, inputs) belong to those
  // controls, not to the row (WCAG 2.1.1: per-row actions stay operable).
  const fromInnerControl = (target: EventTarget, row: HTMLElement) => {
    const control = (target as Element).closest?.(INNER_CONTROLS);
    return Boolean(control && control !== row && row.contains(control));
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: TData) => {
    if (!onRowClick || fromInnerControl(event.target, event.currentTarget)) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row);
    }
  };

  let body;
  if (isLoading) {
    body = <DataTableSkeleton columns={columns.length} />;
  } else if (error) {
    body = (
      <tr>
        <td colSpan={columns.length} className="px-4 py-6">
          <p role="alert" className="text-sm font-medium text-acc-error-text">
            {error.message || 'The data could not be loaded.'}
          </p>
        </td>
      </tr>
    );
  } else if (data.length === 0) {
    body = <DataTableEmpty columns={columns.length}>{emptyState}</DataTableEmpty>;
  } else {
    body = data.map((row) => (
      <tr
        key={getRowKey(row)}
        tabIndex={onRowClick ? 0 : undefined}
        aria-label={onRowClick ? rowActionLabel(row) : undefined}
        onClick={
          onRowClick
            ? (event) => {
                if (!fromInnerControl(event.target, event.currentTarget)) onRowClick(row);
              }
            : undefined
        }
        onKeyDown={onRowClick ? (e) => onRowKeyDown(e, row) : undefined}
        className={cn(
          'border-t border-acc-border text-sm text-acc-text-primary',
          onRowClick &&
            'cursor-pointer hover:bg-acc-surface-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-acc-primary',
        )}
      >
        {columns.map((column) => (
          <td
            key={column.id}
            className={cn(
              'px-4 py-3',
              column.align === 'right' && 'text-right tabular-nums',
              column.align === 'center' && 'text-center',
            )}
          >
            {column.cell(row)}
          </td>
        ))}
      </tr>
    ));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-acc-border bg-acc-card">
      <div className="overflow-x-auto">
        <table aria-busy={busy || undefined} className="w-full border-collapse">
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-acc-surface-raised">
            <tr>
              {columns.map((column) => (
                <DataTableColumnHeader
                  key={column.id}
                  column={column}
                  queryState={queryState}
                  onQueryChange={onQueryChange}
                />
              ))}
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      <DataTablePagination
        queryState={queryState}
        onQueryChange={onQueryChange}
        hasNextPage={hasNextPage}
        hasPreviousPage={hasPreviousPage}
        nextCursor={nextCursor}
        previousCursor={previousCursor}
        totalCount={totalCount}
        disabled={busy}
      />
    </div>
  );
}
