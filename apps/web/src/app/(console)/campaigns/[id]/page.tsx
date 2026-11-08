'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { campaignsApi } from '@/lib/api-client';
import { CampaignDetailView } from '@/components/campaigns/campaign-detail-view';

interface CampaignDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default function CampaignDetailPage({ params }: CampaignDetailPageProps) {
  const { id } = use(params);

  const {
    data: campaignData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['campaigns', 'detail', id],
    queryFn: ({ signal }) => campaignsApi.get(id, signal),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-5 w-32 animate-pulse rounded bg-acc-surface-raised" />
        <div className="h-10 w-64 animate-pulse rounded bg-acc-surface-raised" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-acc-surface-raised" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !campaignData?.data) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-8 text-center">
        <h2 className="text-base font-semibold text-rose-300">Campaign Not Found</h2>
        <p className="mt-1 text-xs text-rose-200">
          The requested campaign record could not be loaded or does not exist.
        </p>
        <div className="mt-4">
          <Link
            href="/campaigns"
            className="inline-flex items-center gap-1.5 rounded-lg bg-acc-primary px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90"
          >
            ← Return to Campaigns Directory
          </Link>
        </div>
      </div>
    );
  }

  return <CampaignDetailView campaign={campaignData.data} onRefresh={() => refetch()} />;
}
