import type { ReactNode } from 'react';

/**
 * Server-driven table contract (U15.1 specification §4.2). The table is a display
 * projection of server state: sorting and pagination are emitted as query changes
 * for the caller to send to the API. The table never filters or sorts rows itself.
 */
export interface DataTableQueryState {
  readonly cursor?: string;
  readonly page?: number;
  readonly pageSize: number;
  readonly sortField?: string;
  readonly sortDirection?: 'asc' | 'desc';
  readonly filters: Record<string, unknown>;
}

export interface DataTableColumn<TData> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: TData) => ReactNode;
  /** Server sort key; the column is sortable only when this is set. */
  readonly sortField?: string;
  readonly align?: 'left' | 'right' | 'center';
  /** Tailwind width class, e.g. `w-40`. */
  readonly width?: string;
}

export interface DataTableProps<TData> {
  /** Accessible name of the table (rendered as its caption). */
  readonly caption: string;
  readonly columns: readonly DataTableColumn<TData>[];
  readonly data: readonly TData[];
  readonly getRowKey: (row: TData) => string;
  readonly totalCount?: number;
  readonly hasNextPage?: boolean;
  readonly hasPreviousPage?: boolean;
  /** Cursor-based pagination: the cursors the server returned for the adjacent pages. */
  readonly nextCursor?: string | null;
  readonly previousCursor?: string | null;
  readonly isLoading: boolean;
  readonly isFetching?: boolean;
  readonly error?: Error | null;
  readonly queryState: DataTableQueryState;
  readonly onQueryChange: (newState: Partial<DataTableQueryState>) => void;
  readonly emptyState: ReactNode;
  readonly onRowClick?: (row: TData) => void;
  /** Accessible label for a clickable row (default: "Open row"). */
  readonly rowActionLabel?: (row: TData) => string;
}
