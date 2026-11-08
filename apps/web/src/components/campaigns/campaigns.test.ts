import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { React: typeof React }).React = React;

import {
  ALL_CAMPAIGN_CHANNELS,
  ALL_CAMPAIGN_STATUSES,
  BACKEND_CAMPAIGN_SUPPORT_STATUS,
  INITIAL_MOCK_CAMPAIGNS,
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
      const res = await campaignsApi.list();
      assert.ok(res.data.length >= 6);
      assert.ok(res.data.every((c) => c.isSimulatedPreview === true));
      assert.strictEqual(res.page.hasMore, false);
    });

    it('campaignsApi.get retrieves individual campaign record and rejects unknown IDs', async () => {
      const res = await campaignsApi.get('cmp-001');
      assert.strictEqual(res.data.name, 'Diwali Festive Sale 2026');
      assert.strictEqual(res.data.channel, 'whatsapp');

      await assert.rejects(
        () => campaignsApi.get('non-existent-campaign-id'),
        (err: unknown) => {
          const apiErr = err as { status?: number; message?: string };
          return apiErr.status === 404 && apiErr.message === 'Campaign not found';
        },
      );
    });

    it('campaignsApi.create prepends a new preview campaign and marks it as simulated preview', async () => {
      const beforeList = await campaignsApi.list();
      const initialCount = beforeList.data.length;

      const createdRes = await campaignsApi.create({
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

      const afterList = await campaignsApi.list();
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
});
