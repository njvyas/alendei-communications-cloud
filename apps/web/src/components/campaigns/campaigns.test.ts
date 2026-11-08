import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { React: typeof React }).React = React;

import {
  ALL_CAMPAIGN_CHANNELS,
  ALL_CAMPAIGN_STATUSES,
  BACKEND_CAMPAIGN_SUPPORT_STATUS,
  DEFAULT_PREVIEW_ORG_ID,
  INITIAL_MOCK_CAMPAIGNS,
  SECONDARY_PREVIEW_ORG_ID,
  calculateCampaignKPIs,
  filterCampaigns,
  getCampaignStatusLabel,
  getCampaignStatusTone,
  getChannelDisplayName,
} from '@/lib/campaigns';
import { campaignsApi } from '@/lib/api-client';
import { useSession, canReadCampaigns, canManageCampaigns } from '@/lib/session-store';
import { CampaignStatusBadge } from './campaign-status-badge';
import { CampaignChannelBadge } from './campaign-channel-badge';
import { CampaignDetailView } from './campaign-detail-view';

describe('Phase 8B Campaigns Module — Unit & Component Tests', () => {
  beforeEach(() => {
    campaignsApi.resetPreview();
    useSession.getState().clearSession();
  });

  describe('1. Invariants & Backend Blocker Status', () => {
    it('flags backend campaign engine as unavailable and specifies missing contracts', () => {
      assert.strictEqual(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.isBackendAvailable,
        false,
        'Backend must be explicitly marked as unavailable',
      );
      assert.ok(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.missingEndpoints.includes(
          'GET /workspaces/:workspaceId/campaigns',
        ),
        'Must document missing list endpoint',
      );
      assert.ok(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.missingEndpoints.includes(
          'POST /workspaces/:workspaceId/campaigns',
        ),
        'Must document missing create endpoint',
      );
      assert.ok(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.missingSchemaTables.includes('campaigns'),
        'Must document missing campaigns table',
      );
      assert.ok(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.missingSchemaTables.includes('campaign_recipients'),
        'Must document missing campaign_recipients table',
      );
      assert.ok(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.notice.includes('Preview mode'),
        'Notice banner text must explicitly mention preview mode',
      );
      assert.strictEqual(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.billingDependency.isBillingEnforced,
        false,
        'Phase 7 billing must be marked as not enforced in preview',
      );
      assert.strictEqual(
        BACKEND_CAMPAIGN_SUPPORT_STATUS.billingDependency.phase,
        'Phase 7 (Billing)',
      );
    });

    it('maps all campaign statuses to accessible labels and design tokens', () => {
      for (const status of ALL_CAMPAIGN_STATUSES) {
        const label = getCampaignStatusLabel(status);
        const tone = getCampaignStatusTone(status);
        assert.ok(label.length > 0, `Status ${status} must have label`);
        assert.ok(['neutral', 'accent', 'success', 'warning', 'error'].includes(tone));
      }
    });

    it('maps all channels to display names', () => {
      assert.strictEqual(ALL_CAMPAIGN_CHANNELS.length, 4);
      assert.strictEqual(getChannelDisplayName('whatsapp'), 'WhatsApp');
      assert.strictEqual(getChannelDisplayName('sms'), 'SMS');
      assert.strictEqual(getChannelDisplayName('email'), 'Email');
      assert.strictEqual(getChannelDisplayName('rcs'), 'RCS');
    });
  });

  describe('2. Campaign Filtering and KPI Calculations', () => {
    it('calculates aggregate KPIs correctly across initial mock campaigns', () => {
      const kpis = calculateCampaignKPIs(INITIAL_MOCK_CAMPAIGNS);

      assert.strictEqual(kpis.totalCampaigns, INITIAL_MOCK_CAMPAIGNS.length);
      // Active campaigns: cmp-002 (running) and cmp-003 (scheduled)
      assert.strictEqual(kpis.activeCampaigns, 2);
      assert.ok(kpis.totalRecipientsTargeted > 0, 'Target recipients must be > 0');
      assert.ok(kpis.totalDelivered > 0, 'Total delivered must be > 0');
      assert.ok(kpis.avgDeliveryRate >= 0 && kpis.avgDeliveryRate <= 100);
    });

    it('filters campaigns by channel', () => {
      const whatsappCampaigns = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { channel: 'whatsapp' });
      assert.ok(whatsappCampaigns.length > 0);
      assert.ok(whatsappCampaigns.every((c) => c.channel === 'whatsapp'));

      const smsCampaigns = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { channel: 'sms' });
      assert.ok(smsCampaigns.length > 0);
      assert.ok(smsCampaigns.every((c) => c.channel === 'sms'));
    });

    it('filters campaigns by status', () => {
      const completed = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { status: 'completed' });
      assert.ok(completed.length > 0);
      assert.ok(completed.every((c) => c.status === 'completed'));

      const running = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { status: 'running' });
      assert.ok(running.length > 0);
      assert.ok(running.every((c) => c.status === 'running'));
    });

    it('filters campaigns by search query', () => {
      const diwaliMatches = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { query: 'Diwali' });
      assert.strictEqual(diwaliMatches.length, 1);
      assert.strictEqual(diwaliMatches[0]?.id, 'cmp-001');

      const nonExistent = filterCampaigns(INITIAL_MOCK_CAMPAIGNS, { query: 'XYZ999NonExistent' });
      assert.strictEqual(nonExistent.length, 0);
    });
  });

  describe('3. Isolated Preview Client & Persistence Boundary', () => {
    it('campaignsApi.list returns mock preview records clearly flagged as simulated preview', async () => {
      const res = await campaignsApi.list(undefined, { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.ok(res.data.length >= 5);
      assert.ok(res.data.every((c) => c.isSimulatedPreview === true));
      assert.strictEqual(res.page.hasMore, false);
    });

    it('campaignsApi.get retrieves individual campaign record and rejects unknown IDs', async () => {
      const res = await campaignsApi.get('cmp-001', { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.strictEqual(res.data.name, 'Diwali Festive Sale 2026');
      assert.strictEqual(res.data.channel, 'whatsapp');

      await assert.rejects(
        () => campaignsApi.get('non-existent-campaign-id', { orgId: DEFAULT_PREVIEW_ORG_ID }),
        (err: unknown) => {
          const apiErr = err as { status?: number; message?: string };
          return apiErr.status === 404 && apiErr.message === 'Campaign not found';
        },
      );
    });

    it('campaignsApi.create prepends a new preview campaign and marks it as simulated preview', async () => {
      const beforeList = await campaignsApi.list(undefined, { orgId: DEFAULT_PREVIEW_ORG_ID });
      const initialCount = beforeList.data.length;

      const createdRes = await campaignsApi.create({
        orgId: DEFAULT_PREVIEW_ORG_ID,
        workspaceId: 'ws-prod',
        name: 'Unit Test Flash Promo',
        description: 'Temporary preview campaign created during unit test',
        channel: 'whatsapp',
        templateId: 'tmpl-unit-01',
        templateName: 'unit_promo_template',
        templateBody: 'Hello {{1}}, check out this unit test promo!',
        recipientSource: {
          type: 'tag_segment',
          tag: 'VIP',
          contactCount: 500,
          segmentName: 'VIP Segment',
        },
        scheduleMode: 'immediate',
      });

      assert.ok(createdRes.data.id.startsWith('cmp-prev-'));
      assert.strictEqual(createdRes.data.name, 'Unit Test Flash Promo');
      assert.strictEqual(createdRes.data.isSimulatedPreview, true);
      assert.strictEqual(createdRes.data.status, 'draft');

      const afterList = await campaignsApi.list(undefined, { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.strictEqual(afterList.data.length, initialCount + 1);
      assert.strictEqual(afterList.data[0]?.id, createdRes.data.id);
    });
  });

  describe('4. Component Static Markup & Accessibility', () => {
    it('CampaignStatusBadge renders status label and screen-reader status prefix', () => {
      const html = renderToStaticMarkup(
        React.createElement(CampaignStatusBadge, { status: 'running' }),
      );
      assert.ok(html.includes('Running'), 'Must include text label "Running"');
      assert.ok(html.includes('Campaign Status'), 'Must include screen reader prefix');
      assert.ok(html.includes('sr-only'), 'Must use sr-only for prefix accessibility');
    });

    it('CampaignChannelBadge renders channel label and accessible aria-label', () => {
      const html = renderToStaticMarkup(
        React.createElement(CampaignChannelBadge, { channel: 'whatsapp' }),
      );
      assert.ok(html.includes('WhatsApp'), 'Must render WhatsApp label');
      assert.ok(
        html.includes('aria-label="Channel: WhatsApp"'),
        'Must have aria-label for channel',
      );
    });

    it('CampaignDetailView renders header, preview banner, KPI tiles, and compliance invariant checklist', () => {
      const mockCampaign = INITIAL_MOCK_CAMPAIGNS[0]!;
      const html = renderToStaticMarkup(
        React.createElement(CampaignDetailView, { campaign: mockCampaign }),
      );

      // Header and Name
      assert.ok(html.includes('Diwali Festive Sale 2026'), 'Must display campaign name');
      assert.ok(html.includes('cmp-001'), 'Must display campaign ID');

      // Backend Blocker Banner
      assert.ok(
        html.includes('Phase 8B Backend Execution Engine Pending'),
        'Must display backend execution engine pending banner',
      );
      assert.ok(html.includes('campaigns_recipients') || html.includes('campaign_recipients'));

      // KPI Metric Cards
      assert.ok(html.includes('Total Target'), 'Must include Total Target KPI card');
      assert.ok(html.includes('24,500'), 'Must format 24,500 recipients');
      assert.ok(html.includes('98.1%'), 'Must include 98.1% delivery rate');

      // Tabs
      assert.ok(html.includes('Overview'), 'Must render Overview tab');
      assert.ok(html.includes('Template &amp; Content') || html.includes('Template & Content'));
      assert.ok(
        html.includes('Audience &amp; Compliance') || html.includes('Audience & Compliance'),
      );

      // Render Audience tab to assert compliance invariants
      const audienceHtml = renderToStaticMarkup(
        React.createElement(CampaignDetailView, { campaign: mockCampaign, defaultTab: 'audience' }),
      );
      assert.ok(
        audienceHtml.includes('Consent Verification Gate'),
        'Must emphasize mandatory consent verification gate',
      );
      assert.ok(
        audienceHtml.includes('Suppression List Filtering'),
        'Must emphasize suppression list filtering',
      );
      assert.ok(
        audienceHtml.includes('Pre-Dispatch Billing &amp; Wallet Gate') ||
          audienceHtml.includes('Pre-Dispatch Billing & Wallet Gate'),
        'Must include Phase 7 billing dependency invariant in checklist',
      );
    });

    it('CampaignDetailView renders unavailable state when audience count cannot be established', () => {
      const mockWithoutCount = INITIAL_MOCK_CAMPAIGNS.find(
        (c) => c.recipientSource.contactCount === null,
      )!;
      assert.ok(mockWithoutCount, 'Fixture with null contactCount must exist');
      const html = renderToStaticMarkup(
        React.createElement(CampaignDetailView, {
          campaign: mockWithoutCount,
          defaultTab: 'audience',
        }),
      );
      assert.ok(
        html.includes('Audience count unavailable — backend preview required'),
        'Must display audience count unavailable notice',
      );
    });

    it('CampaignDetailView renders Illustrative Preview Fixture badge when isSimulatedPreview is true', () => {
      const mockCampaign = INITIAL_MOCK_CAMPAIGNS[0]!;
      const html = renderToStaticMarkup(
        React.createElement(CampaignDetailView, { campaign: mockCampaign }),
      );
      assert.ok(
        html.includes('Illustrative Preview Fixture'),
        'Must display Illustrative Preview Fixture badge in header',
      );
    });
  });

  describe('5. Permission Mapping & Gating Discipline', () => {
    const ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';

    function setSessionGrants(permissions: string[]) {
      useSession.getState().setSession({
        accessToken: 'synth-token',
        user: {
          userId: 'u-1',
          actorType: 'user',
          authMethod: 'session',
          sessionId: 's-1',
          authenticatedAt: new Date().toISOString(),
          tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
          authorizedOrganizationIds: [ORG],
          roles: [],
          permissions,
        },
        authorization: {
          actorType: 'user',
          userId: 'u-1',
          apiKeyId: null,
          isPlatformAdmin: false,
          organizationIds: [ORG],
          grants: [
            {
              roleId: 'role-test',
              roleKey: 'test_role',
              scopeType: 'organization',
              scopeId: ORG,
              orgId: ORG,
              permissions,
            },
          ],
        },
        selectedOrgId: ORG,
      });
    }

    it('canReadCampaigns admits actors with messages.read or messages.send', () => {
      setSessionGrants(['messages.read']);
      assert.strictEqual(canReadCampaigns(), true);

      setSessionGrants(['messages.send']);
      assert.strictEqual(canReadCampaigns(), true);
    });

    it('canReadCampaigns admits actors with dedicated campaigns.read permission', () => {
      setSessionGrants(['campaigns.read']);
      assert.strictEqual(canReadCampaigns(), true);
    });

    it('canManageCampaigns admits actors with dedicated campaigns.manage permission', () => {
      setSessionGrants(['campaigns.manage']);
      assert.strictEqual(canManageCampaigns(), true);
      assert.strictEqual(canReadCampaigns(), true);
    });

    it('canReadCampaigns refuses actors who only hold workspaces.read or organizations.read', () => {
      setSessionGrants(['workspaces.read']);
      assert.strictEqual(canReadCampaigns(), false);

      setSessionGrants(['organizations.read']);
      assert.strictEqual(canReadCampaigns(), false);
    });

    it('canManageCampaigns requires messages.send and refuses actors who only hold templates.manage', () => {
      setSessionGrants(['messages.send']);
      assert.strictEqual(canManageCampaigns(), true);

      setSessionGrants(['templates.manage']);
      assert.strictEqual(canManageCampaigns(), false);

      setSessionGrants(['messages.read']);
      assert.strictEqual(canManageCampaigns(), false);
    });
  });

  describe('6. Tenant-Scoped Isolation (Two Organizations & Two Workspaces)', () => {
    function setupSession(orgId: string) {
      useSession.getState().setSession({
        accessToken: 'synth-token',
        user: {
          userId: 'usr-isolated-test',
          actorType: 'user',
          authMethod: 'session',
          sessionId: 'ses-isolated-test',
          authenticatedAt: new Date().toISOString(),
          tenant: { orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
          authorizedOrganizationIds: [DEFAULT_PREVIEW_ORG_ID, SECONDARY_PREVIEW_ORG_ID],
          roles: [],
          permissions: ['messages.read', 'messages.send'],
        },
        authorization: {
          actorType: 'user',
          userId: 'usr-isolated-test',
          apiKeyId: null,
          isPlatformAdmin: false,
          organizationIds: [DEFAULT_PREVIEW_ORG_ID, SECONDARY_PREVIEW_ORG_ID],
          grants: [
            {
              roleId: 'role-test',
              roleKey: 'test_role',
              scopeType: 'organization',
              scopeId: orgId,
              orgId,
              permissions: ['messages.read', 'messages.send'],
            },
          ],
        },
        selectedOrgId: orgId,
      });
    }

    it('scopes preview list strictly to the active organization context', async () => {
      // Organization A query
      const orgAList = await campaignsApi.list(undefined, { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.strictEqual(orgAList.data.length, 5);
      assert.ok(orgAList.data.every((c) => c.orgId === DEFAULT_PREVIEW_ORG_ID));
      assert.ok(orgAList.data.some((c) => c.id === 'cmp-001'));
      assert.ok(!orgAList.data.some((c) => c.id === 'cmp-006'));

      // Organization B query
      const orgBList = await campaignsApi.list(undefined, { orgId: SECONDARY_PREVIEW_ORG_ID });
      assert.strictEqual(orgBList.data.length, 2);
      assert.ok(orgBList.data.every((c) => c.orgId === SECONDARY_PREVIEW_ORG_ID));
      assert.ok(orgBList.data.some((c) => c.id === 'cmp-006'));
      assert.ok(!orgBList.data.some((c) => c.id === 'cmp-001'));
    });

    it('scopes preview list to specific workspaces within active organization', async () => {
      // Org A workspaces: ws-prod vs ws-marketing
      const wsProdList = await campaignsApi.list('ws-prod', { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.strictEqual(wsProdList.data.length, 3);
      assert.ok(
        wsProdList.data.every(
          (c) => c.orgId === DEFAULT_PREVIEW_ORG_ID && c.workspaceId === 'ws-prod',
        ),
      );

      const wsMarketingList = await campaignsApi.list('ws-marketing', {
        orgId: DEFAULT_PREVIEW_ORG_ID,
      });
      assert.strictEqual(wsMarketingList.data.length, 2);
      assert.ok(
        wsMarketingList.data.every(
          (c) => c.orgId === DEFAULT_PREVIEW_ORG_ID && c.workspaceId === 'ws-marketing',
        ),
      );

      // Org B workspaces: ws-beta-1 vs ws-beta-2
      const wsBeta1List = await campaignsApi.list('ws-beta-1', {
        orgId: SECONDARY_PREVIEW_ORG_ID,
      });
      assert.strictEqual(wsBeta1List.data.length, 1);
      assert.strictEqual(wsBeta1List.data[0]?.id, 'cmp-006');

      const wsBeta2List = await campaignsApi.list('ws-beta-2', {
        orgId: SECONDARY_PREVIEW_ORG_ID,
      });
      assert.strictEqual(wsBeta2List.data.length, 1);
      assert.strictEqual(wsBeta2List.data[0]?.id, 'cmp-007');
    });

    it('prevents cross-tenant record leakage when switching organizations in session store', async () => {
      // 1. Set session to Organization A
      setupSession(DEFAULT_PREVIEW_ORG_ID);
      const resA = await campaignsApi.list();
      assert.strictEqual(resA.data.length, 5);
      assert.ok(resA.data.every((c) => c.orgId === DEFAULT_PREVIEW_ORG_ID));
      assert.ok(resA.data.some((c) => c.id === 'cmp-001'));
      assert.ok(!resA.data.some((c) => c.id === 'cmp-006'));

      // 2. Switch session to Organization B
      setupSession(SECONDARY_PREVIEW_ORG_ID);
      const resB = await campaignsApi.list();
      assert.strictEqual(resB.data.length, 2);
      assert.ok(resB.data.every((c) => c.orgId === SECONDARY_PREVIEW_ORG_ID));
      assert.ok(resB.data.some((c) => c.id === 'cmp-006'));
      assert.ok(!resB.data.some((c) => c.id === 'cmp-001'));
    });

    it('campaignsApi.get enforces tenant and workspace isolation on detail lookups', async () => {
      // Org A campaign can be fetched by Org A
      const resA = await campaignsApi.get('cmp-001', { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.strictEqual(resA.data.id, 'cmp-001');

      // Org A campaign cannot be fetched by Org B (throws 404 NOT_FOUND)
      await assert.rejects(
        () => campaignsApi.get('cmp-001', { orgId: SECONDARY_PREVIEW_ORG_ID }),
        (err: unknown) => {
          const apiErr = err as { status?: number; code?: string };
          return apiErr.status === 404 && apiErr.code === 'NOT_FOUND';
        },
      );

      // Org B campaign can be fetched by Org B
      const resB = await campaignsApi.get('cmp-006', { orgId: SECONDARY_PREVIEW_ORG_ID });
      assert.strictEqual(resB.data.id, 'cmp-006');

      // Org B campaign cannot be fetched by Org A (throws 404 NOT_FOUND)
      await assert.rejects(
        () => campaignsApi.get('cmp-006', { orgId: DEFAULT_PREVIEW_ORG_ID }),
        (err: unknown) => {
          const apiErr = err as { status?: number; code?: string };
          return apiErr.status === 404 && apiErr.code === 'NOT_FOUND';
        },
      );

      // Workspace mismatch within same organization throws 404 NOT_FOUND
      await assert.rejects(
        () =>
          campaignsApi.get('cmp-001', {
            orgId: DEFAULT_PREVIEW_ORG_ID,
            workspaceId: 'ws-marketing',
          }),
        (err: unknown) => {
          const apiErr = err as { status?: number; code?: string };
          return apiErr.status === 404 && apiErr.code === 'NOT_FOUND';
        },
      );
    });

    it('campaignsApi.create assigns the active session organization and selected workspace', async () => {
      setupSession(SECONDARY_PREVIEW_ORG_ID);

      const createdRes = await campaignsApi.create({
        workspaceId: 'ws-beta-1',
        name: 'Secondary Org Exclusive Campaign',
        description: 'Verifying orgId assignment on create',
        channel: 'sms',
        templateId: 'tmpl-sms-beta',
        templateName: 'beta_sms',
        templateBody: 'SMS test for Org B',
        recipientSource: {
          type: 'all_contacts',
          contactCount: 150,
          segmentName: 'All Workspace Contacts',
        },
        scheduleMode: 'immediate',
      });

      assert.strictEqual(createdRes.data.orgId, SECONDARY_PREVIEW_ORG_ID);
      assert.strictEqual(createdRes.data.workspaceId, 'ws-beta-1');
      assert.strictEqual(createdRes.data.isSimulatedPreview, true);

      // Verify campaign is visible to Org B
      const orgBList = await campaignsApi.list(undefined, { orgId: SECONDARY_PREVIEW_ORG_ID });
      assert.ok(orgBList.data.some((c) => c.id === createdRes.data.id));

      // Verify campaign is invisible to Org A
      const orgAList = await campaignsApi.list(undefined, { orgId: DEFAULT_PREVIEW_ORG_ID });
      assert.ok(!orgAList.data.some((c) => c.id === createdRes.data.id));
    });

    it('campaignsApi.list fails closed and returns empty result when organization context is null or unselected', async () => {
      // Ensure session has no selected organization
      useSession.getState().clearSession();

      // 1. Direct call with no arguments and no session
      const noArgList = await campaignsApi.list();
      assert.deepStrictEqual(noArgList.data, []);
      assert.strictEqual(noArgList.page.hasMore, false);

      // 2. Direct call with workspace specified but no org
      const wsList = await campaignsApi.list('ws-prod');
      assert.deepStrictEqual(wsList.data, []);

      // 3. Explicit undefined orgId in params
      const explicitUndefinedList = await campaignsApi.list(undefined, { orgId: undefined });
      assert.deepStrictEqual(explicitUndefinedList.data, []);
    });

    it('campaignsApi.get fails closed when organization context is null or unselected', async () => {
      // Ensure session has no selected organization
      useSession.getState().clearSession();

      // 1. Attempt unscoped lookup with no context and no session
      await assert.rejects(
        () => campaignsApi.get('cmp-001'),
        (err: unknown) => {
          const apiErr = err as { status?: number; code?: string };
          return apiErr.status === 404 && apiErr.code === 'NOT_FOUND';
        },
      );

      // 2. Attempt lookup with explicit undefined orgId
      await assert.rejects(
        () => campaignsApi.get('cmp-001', { orgId: undefined }),
        (err: unknown) => {
          const apiErr = err as { status?: number; code?: string };
          return apiErr.status === 404 && apiErr.code === 'NOT_FOUND';
        },
      );
    });
  });

  describe('7. Live Backend Persistence & Endpoint Contracts (Phase 8B.1)', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls: { url: string; options: RequestInit }[] = [];

    beforeEach(() => {
      fetchCalls = [];
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const options = init ?? {};
        fetchCalls.push({ url, options });

        return new Response(JSON.stringify({ data: { id: 'cmp-live-1', name: 'Live Campaign' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('campaignsApi.listLive targets /workspaces/:workspaceId/campaigns with query parameters', async () => {
      await campaignsApi.listLive('ws-live-1', {
        channel: 'whatsapp',
        status: 'draft',
        query: 'sale',
      });

      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0]?.url.includes('/workspaces/ws-live-1/campaigns'));
      assert.ok(fetchCalls[0]?.url.includes('channel=whatsapp'));
      assert.ok(fetchCalls[0]?.url.includes('status=draft'));
      assert.ok(fetchCalls[0]?.url.includes('query=sale'));
      assert.strictEqual(fetchCalls[0]?.options.method, 'GET');
    });

    it('campaignsApi.getLive targets /workspaces/:workspaceId/campaigns/:id', async () => {
      await campaignsApi.getLive('ws-live-1', 'cmp-123');

      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0]?.url.endsWith('/workspaces/ws-live-1/campaigns/cmp-123'));
      assert.strictEqual(fetchCalls[0]?.options.method, 'GET');
    });

    it('campaignsApi.createLive dispatches POST with Idempotency-Key header', async () => {
      await campaignsApi.createLive(
        'ws-live-1',
        {
          workspaceId: 'ws-live-1',
          name: 'Live Flash Campaign',
          channel: 'whatsapp',
          templateId: '01900000-0000-7000-8000-000000000001',
          templateName: 'live_tpl',
          templateBody: 'Live template body',
          recipientSource: { type: 'all_contacts', contactCount: 50 },
          scheduleMode: 'immediate',
        },
        'test-idem-key',
      );

      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0]?.url.endsWith('/workspaces/ws-live-1/campaigns'));
      assert.strictEqual(fetchCalls[0]?.options.method, 'POST');
      const headers = (fetchCalls[0]?.options.headers ?? {}) as Record<string, string>;
      assert.strictEqual(headers['Idempotency-Key'], 'test-idem-key');
    });

    it('campaignsApi.deleteLive dispatches DELETE to /workspaces/:workspaceId/campaigns/:id', async () => {
      await campaignsApi.deleteLive('ws-live-1', 'cmp-123');

      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0]?.url.endsWith('/workspaces/ws-live-1/campaigns/cmp-123'));
      assert.strictEqual(fetchCalls[0]?.options.method, 'DELETE');
    });

    it('campaignsApi.dispatchLive dispatches POST to /workspaces/:workspaceId/campaigns/:id/dispatch', async () => {
      await campaignsApi.dispatchLive('ws-live-1', 'cmp-123');

      assert.strictEqual(fetchCalls.length, 1);
      assert.ok(fetchCalls[0]?.url.endsWith('/workspaces/ws-live-1/campaigns/cmp-123/dispatch'));
      assert.strictEqual(fetchCalls[0]?.options.method, 'POST');
    });
  });
});
