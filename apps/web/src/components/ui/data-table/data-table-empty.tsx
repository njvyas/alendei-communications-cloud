import type { ReactNode } from 'react';

/** The caller's empty state, spanning all columns. */
export function DataTableEmpty({
  columns,
  children,
}: {
  readonly columns: number;
  readonly children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={columns} className="px-4">
        {children}
      </td>
    </tr>
  );
}
