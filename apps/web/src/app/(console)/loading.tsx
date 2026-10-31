import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export default function ConsoleLoading() {
  return (
    <div role="status" aria-live="polite">
      <Card>
        <CardTitle>Loading</CardTitle>
        <CardDescription>Fetching console data…</CardDescription>
      </Card>
    </div>
  );
}
