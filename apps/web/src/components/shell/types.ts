import type { ComponentType } from 'react';
import type { AuthStatus } from '@/lib/session-store';
import {
  IconApiKeys,
  IconAudit,
  IconCampaigns,
  IconChannels,
  IconContacts,
  IconDomains,
  IconMessages,
  IconOrganizations,
  IconOverview,
  type IconProps,
  IconProviders,
  IconResellers,
  IconRoles,
  IconSupport,
  IconSuppressions,
  IconTeams,
  IconTemplates,
  IconUsage,
  IconUsers,
  IconWhatsApp,
  IconWorkspaces,
} from './icons';

export type NavGroupKey = 'operations' | 'audience' | 'platform' | 'settings' | 'support';

export interface NavItemConfig {
  readonly href: string;
  readonly label: string;
  readonly group: NavGroupKey;
  readonly groupLabel: string;
  readonly icon: ComponentType<IconProps>;
  readonly exact?: boolean;
}

export const NAV_ITEMS: readonly NavItemConfig[] = [
  // 1. Operations
  {
    href: '/',
    label: 'Overview',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconOverview,
    exact: true,
  },
  {
    href: '/messages',
    label: 'Messages',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconMessages,
  },
  {
    href: '/usage',
    label: 'Usage',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconUsage,
  },
  {
    href: '/whatsapp',
    label: 'WhatsApp',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconWhatsApp,
  },
  {
    href: '/templates',
    label: 'Templates',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconTemplates,
  },
  {
    href: '/campaigns',
    label: 'Campaigns',
    group: 'operations',
    groupLabel: 'Operations',
    icon: IconCampaigns,
  },

  // 2. Audience
  {
    href: '/contacts',
    label: 'Contacts',
    group: 'audience',
    groupLabel: 'Audience',
    icon: IconContacts,
  },
  {
    href: '/suppressions',
    label: 'Suppressions',
    group: 'audience',
    groupLabel: 'Audience',
    icon: IconSuppressions,
  },

  // 3. Platform & Infrastructure
  {
    href: '/channels',
    label: 'Channels',
    group: 'platform',
    groupLabel: 'Infrastructure & Platform',
    icon: IconChannels,
  },
  {
    href: '/providers',
    label: 'Providers',
    group: 'platform',
    groupLabel: 'Infrastructure & Platform',
    icon: IconProviders,
  },
  {
    href: '/resellers',
    label: 'Resellers',
    group: 'platform',
    groupLabel: 'Infrastructure & Platform',
    icon: IconResellers,
  },
  {
    href: '/organizations',
    label: 'Organizations',
    group: 'platform',
    groupLabel: 'Infrastructure & Platform',
    icon: IconOrganizations,
  },
  {
    href: '/domains',
    label: 'Domains',
    group: 'platform',
    groupLabel: 'Infrastructure & Platform',
    icon: IconDomains,
  },

  // 4. Administration / Organization Settings
  {
    href: '/workspaces',
    label: 'Workspaces',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconWorkspaces,
  },
  {
    href: '/teams',
    label: 'Teams',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconTeams,
  },
  {
    href: '/users',
    label: 'Users',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconUsers,
  },
  {
    href: '/roles',
    label: 'Roles',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconRoles,
  },
  {
    href: '/api-keys',
    label: 'API Keys',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconApiKeys,
  },
  {
    href: '/audit-logs',
    label: 'Audit Logs',
    group: 'settings',
    groupLabel: 'Administration',
    icon: IconAudit,
  },

  // 5. Platform Support & Ops
  {
    href: '/support',
    label: 'Support & Ops',
    group: 'support',
    groupLabel: 'Platform Support',
    icon: IconSupport,
  },
] as const;

export interface NavVisibilityContext {
  readonly status: AuthStatus;
  readonly canReadMessages: boolean;
  readonly canSendMessages: boolean;
  readonly canReadTemplates: boolean;
  readonly canReadCampaigns: boolean;
  readonly canReadContacts: boolean;
  readonly canReadSuppressions: boolean;
  readonly canReadProviders: boolean;
  readonly canReadResellers: boolean;
  readonly canReadOrganizations: boolean;
  readonly canReadPlatformDomains: boolean;
  readonly canReadWorkspaces: boolean;
  readonly canReadTeams: boolean;
  readonly canReadUsers: boolean;
  readonly canReadRoles: boolean;
  readonly canReadApiKeys: boolean;
  readonly canReadAudit: boolean;
  readonly canAccessSupport: boolean;
}

export function isNavItemVisible(href: string, ctx: NavVisibilityContext): boolean {
  if (ctx.status === 'zero_organizations') {
    switch (href) {
      case '/organizations':
        return ctx.canReadOrganizations;
      case '/domains':
        return ctx.canReadPlatformDomains;
      case '/channels':
      case '/providers':
        return ctx.canReadProviders;
      case '/resellers':
        return ctx.canReadResellers;
      case '/support':
        return ctx.canAccessSupport;
      default:
        return false;
    }
  }

  switch (href) {
    case '/':
      return true;
    case '/messages':
    case '/usage':
      return ctx.canReadMessages;
    case '/whatsapp':
      return ctx.canReadMessages || ctx.canSendMessages;
    case '/templates':
      return ctx.canReadTemplates;
    case '/campaigns':
      return ctx.canReadCampaigns;
    case '/contacts':
      return ctx.canReadContacts;
    case '/suppressions':
      return ctx.canReadSuppressions;
    case '/channels':
    case '/providers':
      return ctx.canReadProviders;
    case '/resellers':
      return ctx.canReadResellers;
    case '/organizations':
      return ctx.canReadOrganizations;
    case '/domains':
      return ctx.canReadPlatformDomains;
    case '/workspaces':
      return ctx.canReadWorkspaces;
    case '/teams':
      return ctx.canReadTeams;
    case '/users':
      return ctx.canReadUsers;
    case '/roles':
      return ctx.canReadRoles;
    case '/api-keys':
      return ctx.canReadApiKeys;
    case '/audit-logs':
      return ctx.canReadAudit;
    case '/support':
      return ctx.canAccessSupport;
    default:
      return false;
  }
}
