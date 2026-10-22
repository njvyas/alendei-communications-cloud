import { PlatformStatus } from '@/components/platform-status';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';

export default function OverviewPage() {
  const isDevelopment = process.env.NEXT_PUBLIC_APP_ENV === 'development';

  return (
    <div className={cn('grid gap-4', isDevelopment && 'sm:grid-cols-2')}>
      {isDevelopment && <PlatformStatus />}
      <Card>
        <CardTitle>Phase 1 & 2 — Foundation & Infrastructure</CardTitle>
        <CardDescription>
          Identity, tenancy, authorization, events, channels catalogue, and provider registry.
          Messaging execution, campaigns, journeys, and inbox arrive in later phases.
        </CardDescription>
      </Card>
    </div>
  );
}
