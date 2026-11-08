import { StatusBadge } from '@/components/ui/badge';
import {
  getCampaignStatusLabel,
  getCampaignStatusTone,
  type CampaignStatus,
} from '@/lib/campaigns';

export interface CampaignStatusBadgeProps {
  readonly status: CampaignStatus;
  readonly className?: string;
}

/**
 * U15.1 compliant StatusBadge wrapper for Campaign lifecycle statuses.
 * Displays accessible shape glyph, tone, and screen-reader prefix.
 */
export function CampaignStatusBadge({ status, className }: CampaignStatusBadgeProps) {
  const tone = getCampaignStatusTone(status);
  const label = getCampaignStatusLabel(status);

  return (
    <StatusBadge variant={tone} label={label} srPrefix="Campaign Status" className={className} />
  );
}
