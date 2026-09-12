import { Card, CardDescription, CardTitle } from '@/components/ui/card';

/**
 * Placeholder for the console sign-in route. The authentication flow itself is
 * implemented in Phase 1B; this exists so the shell's authenticated and
 * unauthenticated layouts are both routable from the start.
 */
export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-sm items-center px-4">
      <Card className="w-full">
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          The console sign-in flow is implemented in Phase 1B (identity and tenancy).
        </CardDescription>
      </Card>
    </div>
  );
}
