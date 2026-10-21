import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import { ProviderAssignmentsCard } from './provider-assignments-card';
import {
  AssignProviderDialog,
  UpdatePriorityDialog,
  ToggleAssignmentDialog,
} from './provider-assignment-dialogs';
import { ActionFeedback } from '../ui/action-feedback';
import { AccessibleDialog } from '../ui/dialog';
import { createAppQueryClient } from '../../lib/query-client';
import { useSession } from '../../lib/session-store';
import type {
  ChannelView,
  EffectiveAuthorization,
  OrganizationProviderAssignment,
  ProviderView,
  UserIdentity,
} from '../../lib/api-client';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-PA: ProviderAssignmentsCard & Dialogs Component Integration & Accessibility Tests', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ASSIGNMENT_ID = '01955b0a-7b3b-7411-9a4f-as0000000001';
  const PROVIDER_ID = '01955b0a-7b3b-7411-9a4f-pr0000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';

  const mockChannel: ChannelView = {
    id: CHANNEL_ID,
    code: 'sms',
    displayName: 'SMS Gateway',
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const mockProvider: ProviderView = {
    id: PROVIDER_ID,
    channelId: CHANNEL_ID,
    channelCode: 'sms',
    name: 'Twilio SMS Primary',
    adapterKey: 'twilio-sms',
    status: 'active',
    healthState: 'healthy',
    healthOverride: null,
    healthChangedAt: null,
    circuitState: 'closed',
    circuitChangedAt: null,
    circuitCooldownUntil: null,
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const mockAssignment: OrganizationProviderAssignment = {
    id: ASSIGNMENT_ID,
    orgId: ORG_A,
    providerId: PROVIDER_ID,
    channelId: CHANNEL_ID,
    priority: 1,
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const setupSession = (grants: EffectiveAuthorization['grants']) => {
    const user: UserIdentity = {
      userId: 'test-admin-1',
      email: 'operator@alendei.com',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: true },
      authorizedOrganizationIds: [ORG_A],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-admin-1',
      apiKeyId: null,
      organizationIds: [ORG_A],
      grants,
      isPlatformAdmin: true,
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user,
      authorization,
      selectedOrgId: ORG_A,
    });
  };

  const renderWithQueryClient = (component: React.ReactNode, client: QueryClient) =>
    renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, component));

  afterEach(() => {
    useSession.getState().clearSession();
  });

  // =========================================================================
  // 1. Permission Gating & Life-cycle State
  // =========================================================================
  describe('1. Permission Gating & Life-cycle State Invariants', () => {
    it('suppresses ProviderAssignmentsCard entirely when caller lacks providers.read', () => {
      // User has only organization-level grants
      setupSession([
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_A,
          orgId: ORG_A,
          permissions: ['workspaces.read', 'teams.read'],
        },
      ]);

      const client = createAppQueryClient();
      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );
      assert.equal(html, '', 'Card must render null when caller lacks providers.read');
    });

    it('renders assignments table but suppresses mutation controls for read-only platform operator', () => {
      setupSession([
        {
          roleId: 'role-plat-reader',
          roleKey: 'platform_reader',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [mockAssignment],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );

      // Renders table and metadata
      assert.ok(html.includes('Provider Assignments'));
      assert.ok(html.includes('SMS Gateway'));
      assert.ok(html.includes('Twilio SMS Primary'));
      assert.ok(html.includes('twilio-sms'));
      assert.ok(html.includes('#1'));
      assert.ok(html.includes('Active'));

      // Suppresses mutation controls
      assert.ok(!html.includes('+ Assign Provider'), 'Must not render "+ Assign Provider"');
      assert.ok(!html.includes('Edit Priority'), 'Must not render "Edit Priority"');
      assert.ok(!html.includes('Disable'), 'Must not render "Disable"');
    });

    it('renders mutation controls when caller holds platform providers.manage on active organization', () => {
      setupSession([
        {
          roleId: 'role-plat-mgr',
          roleKey: 'platform_manager',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read', 'providers.manage'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [mockAssignment],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );

      assert.ok(html.includes('+ Assign Provider'));
      assert.ok(html.includes('Edit Priority'));
      assert.ok(html.includes('Disable'));
    });

    it('strictly suppresses mutation controls when organization is in closed terminal status', () => {
      setupSession([
        {
          roleId: 'role-plat-mgr',
          roleKey: 'platform_manager',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read', 'providers.manage'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [mockAssignment],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'closed' }),
        client,
      );

      assert.ok(html.includes('Provider Assignments'));
      assert.ok(!html.includes('+ Assign Provider'), 'Mutations must be disabled on closed org');
      assert.ok(!html.includes('Edit Priority'), 'Edit Priority must be disabled on closed org');
      assert.ok(!html.includes('Disable'), 'Disable must be disabled on closed org');
    });

    it('renders empty state with call-to-action when no assignments exist', () => {
      setupSession([
        {
          roleId: 'role-plat-mgr',
          roleKey: 'platform_manager',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read', 'providers.manage'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );

      assert.ok(html.includes('No provider assignments configured'));
      assert.ok(html.includes('Assign First Provider'));
    });
  });

  // =========================================================================
  // 2. Dialog Accessibility & Confirmation Semantics
  // =========================================================================
  describe('2. Dialog Accessibility & Confirmation Semantics', () => {
    it('AccessibleDialog renders accessible modal semantics and hides when closed', () => {
      const openHtml = renderToStaticMarkup(
        React.createElement(
          AccessibleDialog,
          {
            isOpen: true,
            onClose: () => {},
            titleId: 'test-modal-title',
            descriptionId: 'test-modal-desc',
          },
          React.createElement('h2', { id: 'test-modal-title' }, 'Test Title'),
          React.createElement('p', { id: 'test-modal-desc' }, 'Test Description'),
        ),
      );

      assert.ok(openHtml.includes('role="dialog"'));
      assert.ok(openHtml.includes('aria-modal="true"'));
      assert.ok(openHtml.includes('aria-labelledby="test-modal-title"'));
      assert.ok(openHtml.includes('aria-describedby="test-modal-desc"'));
      assert.ok(openHtml.includes('Test Title'));

      const closedHtml = renderToStaticMarkup(
        React.createElement(
          AccessibleDialog,
          {
            isOpen: false,
            onClose: () => {},
            titleId: 'test-modal-title',
          },
          React.createElement('h2', { id: 'test-modal-title' }, 'Test Title'),
        ),
      );
      assert.equal(closedHtml, '', 'Dialog must render null when isOpen is false');
    });

    it('AssignProviderDialog renders accessible dialog with provider selection and priority input', () => {
      const html = renderToStaticMarkup(
        React.createElement(AssignProviderDialog, {
          isOpen: true,
          orgId: ORG_A,
          providers: [mockProvider],
          channels: [mockChannel],
          existingAssignments: [],
          onClose: () => {},
          onSuccess: () => {},
        }),
      );

      assert.ok(html.includes('role="dialog"'));
      assert.ok(html.includes('aria-modal="true"'));
      assert.ok(html.includes('Assign Provider'));
      assert.ok(html.includes('Candidate Priority'));
      assert.ok(html.includes('Twilio SMS Primary'));
      assert.ok(html.includes('SMS Gateway'));
      assert.ok(html.includes('Active (available for immediate routing)'));
    });

    it('UpdatePriorityDialog renders current priority context and priority input', () => {
      const html = renderToStaticMarkup(
        React.createElement(UpdatePriorityDialog, {
          isOpen: true,
          orgId: ORG_A,
          assignment: mockAssignment,
          providerName: 'Twilio SMS Primary',
          channelName: 'SMS Gateway',
          otherPrioritiesForChannel: [2, 3],
          onClose: () => {},
          onSuccess: () => {},
        }),
      );

      assert.ok(html.includes('Change Routing Priority'));
      assert.ok(html.includes('Twilio SMS Primary'));
      assert.ok(html.includes('#1'));
      assert.ok(html.includes('Other in-use priorities for this channel: 2, 3'));
    });

    it('ToggleAssignmentDialog renders routing impact warning when disabling an assignment', () => {
      const html = renderToStaticMarkup(
        React.createElement(ToggleAssignmentDialog, {
          isOpen: true,
          orgId: ORG_A,
          assignment: mockAssignment,
          providerName: 'Twilio SMS Primary',
          channelName: 'SMS Gateway',
          action: 'disable',
          onClose: () => {},
          onSuccess: () => {},
        }),
      );

      assert.ok(html.includes('Disable Provider Assignment'));
      assert.ok(html.includes('Routing Impact Warning'));
      assert.ok(
        html.includes(
          'Outbound messages for this organization will no longer attempt dispatch through Twilio SMS Primary',
        ),
      );
      assert.ok(html.includes('Disable Assignment'));
    });

    it('ToggleAssignmentDialog renders reinstatement notice when enabling an assignment', () => {
      const disabledAssignment = { ...mockAssignment, status: 'disabled' as const };
      const html = renderToStaticMarkup(
        React.createElement(ToggleAssignmentDialog, {
          isOpen: true,
          orgId: ORG_A,
          assignment: disabledAssignment,
          providerName: 'Twilio SMS Primary',
          channelName: 'SMS Gateway',
          action: 'enable',
          onClose: () => {},
          onSuccess: () => {},
        }),
      );

      assert.ok(html.includes('Enable Provider Assignment'));
      assert.ok(html.includes('Reinstating Provider'));
      assert.ok(
        html.includes('will become an active routing candidate for SMS Gateway with priority #1'),
      );
      assert.ok(html.includes('Enable Assignment'));
    });
  });

  // =========================================================================
  // 3. ActionFeedback Accessibility & Diagnostics
  // =========================================================================
  describe('3. ActionFeedback Accessibility & Diagnostics', () => {
    it('ActionFeedback renders role="alert" with aria-live="polite" for error feedback', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActionFeedback, {
          feedback: {
            type: 'error',
            title: 'Priority Conflict',
            message: 'Priority 1 is already in use.',
            code: 'ASSIGNMENT_PRIORITY_CONFLICT',
            correlationId: 'req-corr-999',
          },
        }),
      );

      assert.ok(html.includes('role="alert"'));
      assert.ok(html.includes('aria-live="polite"'));
      assert.ok(html.includes('Priority Conflict'));
      assert.ok(html.includes('Priority 1 is already in use.'));
      assert.ok(html.includes('Code: ASSIGNMENT_PRIORITY_CONFLICT'));
      assert.ok(html.includes('Ref: req-corr-999'));
    });

    it('ActionFeedback renders role="status" for success feedback', () => {
      const html = renderToStaticMarkup(
        React.createElement(ActionFeedback, {
          feedback: {
            type: 'success',
            title: 'Provider Assigned',
            message: 'New assignment created.',
          },
        }),
      );

      assert.ok(html.includes('role="status"'));
      assert.ok(html.includes('aria-live="polite"'));
      assert.ok(html.includes('Provider Assigned'));
      assert.ok(html.includes('New assignment created.'));
    });

    it('ActionFeedback renders null when feedback is null', () => {
      const html = renderToStaticMarkup(React.createElement(ActionFeedback, { feedback: null }));
      assert.equal(html, '');
    });
  });

  // =========================================================================
  // 6. Provider Assignments Cursor Pagination Controls
  // =========================================================================
  describe('6. Provider Assignments Cursor Pagination Controls', () => {
    it('renders pagination controls when hasMore is true', () => {
      setupSession([
        {
          roleId: 'role-plat-reader',
          roleKey: 'platform_reader',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [mockAssignment],
        page: { hasMore: true, nextCursor: 'cursor-page-2-token' },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );

      assert.ok(html.includes('Page 1'));
      assert.ok(html.includes('Previous'));
      assert.ok(html.includes('Next'));
    });

    it('suppresses pagination controls when hasMore is false and single page', () => {
      setupSession([
        {
          roleId: 'role-plat-reader',
          roleKey: 'platform_reader',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['providers.read'],
        },
      ]);

      const client = createAppQueryClient();
      client.setQueryData(['organizations', ORG_A, 'provider-assignments'], {
        data: [mockAssignment],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['providers', 'list'], {
        data: [mockProvider],
        page: { hasMore: false, nextCursor: null },
      });
      client.setQueryData(['channels', 'list'], {
        data: [mockChannel],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(
        React.createElement(ProviderAssignmentsCard, { orgId: ORG_A, orgStatus: 'active' }),
        client,
      );

      assert.ok(!html.includes('Page 1'));
      assert.ok(!html.includes('Previous'));
      assert.ok(!html.includes('Next'));
    });
  });
});
