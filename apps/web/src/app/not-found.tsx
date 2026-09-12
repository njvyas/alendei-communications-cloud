import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col items-start justify-center gap-3 px-4">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-[var(--color-ink-muted)]">
        That route does not exist in the console.
      </p>
      <Link href="/" className="text-sm underline">
        Back to overview
      </Link>
    </div>
  );
}
