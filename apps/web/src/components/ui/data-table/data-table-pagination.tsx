'use client';

import { Button } from '../button';

import type { DataTableQueryState } from './types';

/**
 * Previous / next pagination. With cursors, the server-provided cursor is emitted;
 * otherwise the page number. Nothing is computed from the rows on screen.
 */
export function DataTablePagination({
  queryState,
  onQueryChange,
  hasNextPage,
  hasPreviousPage,
  nextCursor,
  previousCursor,
  totalCount,
  disabled,
}: {
  readonly queryState: DataTableQueryState;
  readonly onQueryChange: (state: Partial<DataTableQueryState>) => void;
  readonly hasNextPage?: boolean;
  readonly hasPreviousPage?: boolean;
  readonly nextCursor?: string | null;
  readonly previousCursor?: string | null;
  readonly totalCount?: number;
  readonly disabled?: boolean;
}) {
  const cursorMode = nextCursor !== undefined || previousCursor !== undefined;
  const page = queryState.page ?? 1;
  const pages =
    totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / queryState.pageSize)) : undefined;
  return (
    <nav
      aria-label="Pagination"
      className="flex items-center justify-between gap-3 border-t border-acc-border px-4 py-3"
    >
      <p className="text-xs text-acc-text-secondary" aria-live="polite">
        {pages !== undefined ? `Page ${page} of ${pages}` : `Page ${page}`}
        {totalCount !== undefined && ` · ${totalCount.toLocaleString()} total`}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !hasPreviousPage}
          onClick={() =>
            onQueryChange(
              cursorMode
                ? { cursor: previousCursor ?? undefined, page: Math.max(1, page - 1) }
                : { page: Math.max(1, page - 1) },
            )
          }
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !hasNextPage}
          onClick={() =>
            onQueryChange(
              cursorMode ? { cursor: nextCursor ?? undefined, page: page + 1 } : { page: page + 1 },
            )
          }
        >
          Next
        </Button>
      </div>
    </nav>
  );
}
