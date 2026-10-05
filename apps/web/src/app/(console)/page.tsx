import { PlatformStatus } from '@/components/platform-status';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export default function OverviewPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <PlatformStatus />
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
