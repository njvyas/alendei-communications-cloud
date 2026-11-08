import { Badge } from '@/components/ui/badge';
import { getChannelDisplayName, type CampaignChannel } from '@/lib/campaigns';

export interface CampaignChannelBadgeProps {
  readonly channel: CampaignChannel;
  readonly className?: string;
}

function ChannelIcon({ channel }: { readonly channel: CampaignChannel }) {
  const common = {
    viewBox: '0 0 16 16',
    className: 'size-3.5 shrink-0',
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.5',
  } as const;

  switch (channel) {
    case 'whatsapp':
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 1.5a6.5 6.5 0 00-5.63 9.75L1.5 14.5l3.35-.88A6.5 6.5 0 108 1.5z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M5.75 6.25c.25-.5.75-.5 1 0 .25.5.5 1 .75 1.25.25.25.25.5 0 .75l-.5.5c.5 1 1.25 1.75 2.25 2.25l.5-.5c.25-.25.5-.25.75 0 .25.25.75.5 1.25.75.5.25.5.75 0 1-.75.75-2 .5-3.5-1s-1.75-2.75-1-3.5z"
          />
        </svg>
      );
    case 'sms':
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2 4.5A1.5 1.5 0 013.5 3h9A1.5 1.5 0 0114 4.5v6a1.5 1.5 0 01-1.5 1.5H5.5L2 14.5v-10z"
          />
          <circle cx="5" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="8" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="11" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'email':
      return (
        <svg {...common}>
          <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
          <path strokeLinecap="round" strokeLinejoin="round" d="m3 5 5 4 5-4" />
        </svg>
      );
    case 'rcs':
      return (
        <svg {...common}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v7a1.5 1.5 0 01-1.5 1.5H9l-3 2.5v-2.5H3.5A1.5 1.5 0 012 10.5v-7z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.5 6.5h5M5.5 8.5h3" />
        </svg>
      );
  }
}

/**
 * Visual badge displaying the channel icon and label.
 */
export function CampaignChannelBadge({ channel, className }: CampaignChannelBadgeProps) {
  const displayName = getChannelDisplayName(channel);

  return (
    <Badge
      variant="neutral"
      icon={<ChannelIcon channel={channel} />}
      className={className}
      aria-label={`Channel: ${displayName}`}
    >
      {displayName}
    </Badge>
  );
}
