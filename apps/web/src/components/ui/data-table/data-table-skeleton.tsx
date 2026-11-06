/** Loading rows: decorative pulse placeholders; the table itself is `aria-busy`. */
export function DataTableSkeleton({
  columns,
  rows = 5,
}: {
  readonly columns: number;
  readonly rows?: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden="true" className="border-t border-acc-border">
          {Array.from({ length: columns }, (_, c) => (
            <td key={c} className="px-4 py-3">
              <span className="block h-4 w-full max-w-40 animate-pulse rounded bg-acc-surface-raised motion-reduce:animate-none" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
