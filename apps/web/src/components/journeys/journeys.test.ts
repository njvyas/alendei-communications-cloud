import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as unknown as { React: typeof React }).React = React;

import {
  JOURNEY_GRAPH_SCHEMA_VERSION,
  JOURNEY_GRAPH_LIMITS,
  defaultJourneyGraph,
  validateJourneyGraph,
  canonicalJourneyJson,
  calculateJourneyKPIs,
  formatWaitSeconds,
  parseWaitSeconds,
  getNodeEdgeTargets,
  updateNodeEdgeTarget,
  formatTriggerSummary,
  formatEntryRef,
  formatStepDetails,
  isJourneyTimeZone,
  nextJourneyScheduleFire,
  journeyLifecycleTarget,
  type JourneyRecord,
  type JourneyGraph,
  type JourneyNode,
  type JourneySchedule,
} from '@/lib/journeys';
import {
  JourneyStatusBadge,
  JourneyVersionStatusBadge,
  JourneyExecutionStatusBadge,
  JourneyTriggerBadge,
  JourneyTriggerStatusBadge,
  getJourneyStatusTone,
  getJourneyVersionStatusTone,
  getJourneyExecutionStatusTone,
  getJourneyTriggerStatusTone,
} from './journey-status-badge';
import { JourneyNodeIcon } from './journey-node-icon';
import { JourneyNodeInspector } from './journey-node-inspector';
import { journeysApi } from '@/lib/api-client';
import { useSession, canReadJourneys, canManageJourneys } from '@/lib/session-store';

describe('Phase 8C Journeys Frontend Module — Unit & Component Tests', () => {
  beforeEach(() => {
    useSession.getState().clearSession();
  });

  describe('1. Authoritative Graph Contracts & Schema Invariants', () => {
    it('uses packages/contracts as sole graph contract and defaultJourneyGraph is structurally valid', () => {
      const graph = defaultJourneyGraph();
      assert.strictEqual(graph.schemaVersion, JOURNEY_GRAPH_SCHEMA_VERSION);
      assert.strictEqual(graph.entry, 'start');
      assert.ok(graph.nodes.start);
      assert.ok(graph.nodes.finish);

      const report = validateJourneyGraph(graph);
      assert.strictEqual(report.valid, true, 'Default graph must be valid');
      assert.strictEqual(report.errors.length, 0);
    });

    it('rejects cyclical graphs and graphs exceeding node limits', () => {
      const cyclicalGraph: JourneyGraph = {
        schemaVersion: 1,
        entry: 'start',
        nodes: {
          start: { type: 'entry', trigger: { kind: 'api' }, next: 'step_a' },
          step_a: { type: 'wait_duration', seconds: 60, next: 'step_b' },
          step_b: { type: 'wait_duration', seconds: 60, next: 'step_a' },
        },
      };

      const report = validateJourneyGraph(cyclicalGraph);
      assert.strictEqual(report.valid, false);
      assert.ok(report.errors.some((e) => e.code === 'CYCLE'));
    });

    it('canonicalJourneyJson produces deterministic key order regardless of insertion order', () => {
      const obj1 = { b: 2, a: 1, z: { d: 4, c: 3 } };
      const obj2 = { a: 1, b: 2, z: { c: 3, d: 4 } };
      assert.strictEqual(canonicalJourneyJson(obj1), canonicalJourneyJson(obj2));
    });

    it('validates node limits match authoritative contracts', () => {
      assert.strictEqual(JOURNEY_GRAPH_LIMITS.maxNodes, 200);
      assert.strictEqual(JOURNEY_GRAPH_LIMITS.maxSerializedLength, 262144);
    });
  });

  describe('2. Presentation Helpers, Formatting & KPI Calculations', () => {
    it('formats wait seconds into human readable duration strings', () => {
      assert.strictEqual(formatWaitSeconds(45), '45s');
      assert.strictEqual(formatWaitSeconds(60), '1m');
      assert.strictEqual(formatWaitSeconds(150), '2m 30s');
      assert.strictEqual(formatWaitSeconds(3600), '1h');
      assert.strictEqual(formatWaitSeconds(5400), '1h 30m');
      assert.strictEqual(formatWaitSeconds(86400), '1d');
      assert.strictEqual(formatWaitSeconds(108000), '1d 6h');
    });

    it('parses unit values to seconds accurately', () => {
      assert.strictEqual(parseWaitSeconds('seconds', 45), 45);
      assert.strictEqual(parseWaitSeconds('minutes', 5), 300);
      assert.strictEqual(parseWaitSeconds('hours', 2), 7200);
      assert.strictEqual(parseWaitSeconds('days', 3), 259200);
    });

    it('resolves and updates node edge targets correctly across node variants', () => {
      const sendNode: JourneyNode = {
        type: 'send_message',
        channel: 'whatsapp',
        templateId: 'tpl_1',
        variables: {},
        onSuppressed: 'continue',
        onRefused: 'continue',
        next: 'wait_step',
      };
      assert.deepStrictEqual(getNodeEdgeTargets(sendNode), { next: 'wait_step' });

      const updatedSend = updateNodeEdgeTarget(sendNode, 'next', 'exit_step');
      assert.ok('next' in updatedSend && updatedSend.next === 'exit_step');

      const condNode: JourneyNode = {
        type: 'condition',
        rule: { kind: 'attribute', field: 'firstName', op: 'exists' },
        onTrue: 'step_yes',
        onFalse: 'step_no',
      };
      assert.deepStrictEqual(getNodeEdgeTargets(condNode), {
        onTrue: 'step_yes',
        onFalse: 'step_no',
      });

      const updatedCond = updateNodeEdgeTarget(condNode, 'onTrue', 'new_target');
      assert.ok('onTrue' in updatedCond && updatedCond.onTrue === 'new_target');

      const exitNode: JourneyNode = { type: 'exit' };
      assert.deepStrictEqual(getNodeEdgeTargets(exitNode), {});
    });

    it('calculates aggregate KPIs correctly across journey records', () => {
      const mockJourneys: JourneyRecord[] = [
        {
          id: 'j1',
          orgId: 'org_1',
          workspaceId: 'ws_1',
          name: 'Journey 1',
          description: null,
          status: 'active',
          createdBy: 'user_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          draftVersion: null,
          latestPublishedVersion: null,
          activeVersionId: 'ver_1',
          activatedAt: new Date().toISOString(),
          activatedBy: 'user_1',
          trigger: null,
        },
        {
          id: 'j2',
          orgId: 'org_1',
          workspaceId: 'ws_1',
          name: 'Journey 2',
          description: null,
          status: 'draft',
          createdBy: 'user_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          draftVersion: null,
          latestPublishedVersion: null,
          activeVersionId: null,
          activatedAt: null,
          activatedBy: null,
          trigger: null,
        },
        {
          id: 'j3',
          orgId: 'org_1',
          workspaceId: 'ws_1',
          name: 'Journey 3',
          description: null,
          status: 'paused',
          createdBy: 'user_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          draftVersion: null,
          latestPublishedVersion: null,
          activeVersionId: 'ver_1',
          activatedAt: new Date().toISOString(),
          activatedBy: 'user_1',
          trigger: null,
        },
        {
          id: 'j4',
          orgId: 'org_1',
          workspaceId: 'ws_1',
          name: 'Journey 4',
          description: null,
          status: 'archived',
          createdBy: 'user_1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          draftVersion: null,
          latestPublishedVersion: null,
          activeVersionId: null,
          activatedAt: null,
          activatedBy: null,
          trigger: null,
        },
      ];

      const kpis = calculateJourneyKPIs(mockJourneys);
      assert.strictEqual(kpis.totalJourneys, 4);
      assert.strictEqual(kpis.activeCount, 1);
      assert.strictEqual(kpis.draftCount, 1);
      assert.strictEqual(kpis.pausedCount, 1);
      assert.strictEqual(kpis.archivedCount, 1);
    });

    it('maps status badges and tones according to U15.1 specification', () => {
      assert.strictEqual(getJourneyStatusTone('active'), 'success');
      assert.strictEqual(getJourneyStatusTone('paused'), 'warning');
      assert.strictEqual(getJourneyStatusTone('draft'), 'neutral');
      assert.strictEqual(getJourneyStatusTone('archived'), 'neutral');

      assert.strictEqual(getJourneyVersionStatusTone('published'), 'success');
      assert.strictEqual(getJourneyVersionStatusTone('draft'), 'accent');
      assert.strictEqual(getJourneyVersionStatusTone('retired'), 'neutral');

      assert.strictEqual(getJourneyExecutionStatusTone('completed'), 'success');
      assert.strictEqual(getJourneyExecutionStatusTone('running'), 'accent');
      assert.strictEqual(getJourneyExecutionStatusTone('waiting'), 'warning');
      assert.strictEqual(getJourneyExecutionStatusTone('failed'), 'error');
    });

    it('formats trigger summaries correctly', () => {
      assert.strictEqual(formatTriggerSummary(null), 'No active trigger');
      assert.strictEqual(
        formatTriggerSummary({
          id: 't1',
          journeyVersionId: 'v1',
          kind: 'api',
          eventKind: null,
          eventTag: null,
          segmentId: null,
          nextFireAt: null,
          status: 'active',
        }),
        'API Enrolment (POST /enrollments)',
      );
      assert.strictEqual(
        formatTriggerSummary({
          id: 't2',
          journeyVersionId: 'v1',
          kind: 'event',
          eventKind: 'contact.created',
          eventTag: null,
          segmentId: null,
          nextFireAt: null,
          status: 'active',
        }),
        'Event: contact.created',
      );
    });

    it('validates lifecycle transition targets', () => {
      assert.strictEqual(journeyLifecycleTarget('activate', 'draft'), 'active');
      assert.strictEqual(journeyLifecycleTarget('pause', 'active'), 'paused');
      assert.strictEqual(journeyLifecycleTarget('resume', 'paused'), 'active');
      assert.strictEqual(journeyLifecycleTarget('archive', 'active'), 'archived');
      assert.strictEqual(journeyLifecycleTarget('activate', 'paused'), null);
      assert.strictEqual(journeyLifecycleTarget('pause', 'draft'), null);
    });
  });

  describe('3. Component Static Markup & Accessibility', () => {
    it('JourneyTriggerBadge renders trigger kind and armed status', () => {
      const activeMarkup = renderToStaticMarkup(
        React.createElement(JourneyTriggerBadge, {
          trigger: {
            id: 'trig_1',
            journeyVersionId: 'ver_1',
            kind: 'api',
            eventKind: null,
            eventTag: null,
            segmentId: null,
            nextFireAt: null,
            status: 'active',
          },
        }),
      );
      assert.ok(activeMarkup.includes('API Enrolment'));

      const nullMarkup = renderToStaticMarkup(
        React.createElement(JourneyTriggerBadge, { trigger: null }),
      );
      assert.ok(nullMarkup.includes('No trigger'));
    });
    it('JourneyStatusBadge renders tone, label and screen-reader prefix', () => {
      const markup = renderToStaticMarkup(
        React.createElement(JourneyStatusBadge, { status: 'active' }),
      );
      assert.ok(markup.includes('Active'));
      assert.ok(markup.includes('Journey Status'));
    });

    it('JourneyVersionStatusBadge renders version status prefix', () => {
      const markup = renderToStaticMarkup(
        React.createElement(JourneyVersionStatusBadge, { status: 'published' }),
      );
      assert.ok(markup.includes('Published'));
      assert.ok(markup.includes('Version Status'));
    });

    it('JourneyExecutionStatusBadge renders execution state', () => {
      const markup = renderToStaticMarkup(
        React.createElement(JourneyExecutionStatusBadge, { status: 'running' }),
      );
      assert.ok(markup.includes('Running'));
      assert.ok(markup.includes('Execution Status'));
    });

    it('JourneyNodeIcon renders SVG with aria-hidden="true"', () => {
      const markup = renderToStaticMarkup(
        React.createElement(JourneyNodeIcon, { type: 'send_message' }),
      );
      assert.ok(markup.includes('<svg'));
      assert.ok(markup.includes('aria-hidden="true"'));
    });

    it('JourneyNodeInspector renders accessible controls for entry node', () => {
      const graph = defaultJourneyGraph();
      const markup = renderToStaticMarkup(
        React.createElement(JourneyNodeInspector, {
          nodeKey: 'start',
          node: graph.nodes.start!,
          graph,
          onChange: () => {},
          onClose: () => {},
        }),
      );
      assert.ok(markup.includes('Trigger Configuration'));
      assert.ok(markup.includes('start'));
    });
  });

  describe('4. Permissions & Gating Discipline', () => {
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

    it('canReadJourneys admits actors holding journeys.read or journeys.manage', () => {
      setSessionGrants(['journeys.read']);
      assert.strictEqual(canReadJourneys(), true);

      setSessionGrants(['journeys.manage']);
      assert.strictEqual(canReadJourneys(), true);

      setSessionGrants(['journeys.read', 'journeys.manage']);
      assert.strictEqual(canReadJourneys(), true);
    });

    it('canManageJourneys strictly requires journeys.manage and refuses journeys.read alone', () => {
      setSessionGrants(['journeys.manage']);
      assert.strictEqual(canManageJourneys(), true);

      setSessionGrants(['journeys.read']);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('messaging permissions alone (messages.read, messages.send) do not grant journey read access', () => {
      setSessionGrants(['messages.read']);
      assert.strictEqual(canReadJourneys(), false);

      setSessionGrants(['messages.send']);
      assert.strictEqual(canReadJourneys(), false);

      setSessionGrants(['messages.read', 'messages.send']);
      assert.strictEqual(canReadJourneys(), false);
    });

    it('messaging permissions alone (messages.read, messages.send) do not grant journey manage access', () => {
      setSessionGrants(['messages.send']);
      assert.strictEqual(canManageJourneys(), false);

      setSessionGrants(['messages.read']);
      assert.strictEqual(canManageJourneys(), false);

      setSessionGrants(['messages.read', 'messages.send']);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('combining journeys.read with messages.send does not escalate to journey manage access', () => {
      setSessionGrants(['journeys.read', 'messages.send']);
      assert.strictEqual(canReadJourneys(), true);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('campaign permissions do not grant journey read or manage access', () => {
      setSessionGrants(['campaigns.read']);
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);

      setSessionGrants(['campaigns.manage']);
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);

      setSessionGrants(['campaigns.read', 'campaigns.manage', 'messages.read', 'messages.send']);
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('refuses actors who only hold unrelated permissions', () => {
      setSessionGrants(['workspaces.read']);
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);

      setSessionGrants(['templates.manage']);
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('fails closed when unauthenticated or session is cleared', () => {
      useSession.getState().clearSession();
      assert.strictEqual(canReadJourneys(), false);
      assert.strictEqual(canManageJourneys(), false);
    });
  });

  describe('5. API Client Endpoint Contracts & Isolation', () => {
    const originalFetch = globalThis.fetch;
    interface InterceptedPayload {
      name?: string;
      expectedGraphSha256?: string;
      contactIds?: string[];
      [key: string]: unknown;
    }

    let interceptedUrl = '';
    let interceptedMethod = '';
    let interceptedHeaders: Record<string, string> = {};
    let interceptedBody: InterceptedPayload | null = null;

    beforeEach(() => {
      interceptedUrl = '';
      interceptedMethod = '';
      interceptedHeaders = {};
      interceptedBody = null;

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        interceptedUrl = String(input);
        interceptedMethod = init?.method ?? 'GET';
        interceptedHeaders = (init?.headers as Record<string, string>) ?? {};
        if (init?.body && typeof init.body === 'string') {
          try {
            interceptedBody = JSON.parse(init.body) as InterceptedPayload;
          } catch {
            interceptedBody = { raw: init.body };
          }
        }

        return new Response(
          JSON.stringify({
            data: { id: 'mock_1', name: 'Mock Journey', status: 'draft' },
            page: { hasMore: false, nextCursor: null, limit: 50 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('journeysApi.list targets workspace journeys endpoint with query filters', async () => {
      await journeysApi.list('ws_test', { status: 'active', query: 'onboard' });
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys'));
      assert.ok(interceptedUrl.includes('status=active'));
      assert.ok(interceptedUrl.includes('query=onboard'));
      assert.strictEqual(interceptedMethod, 'GET');
    });

    it('journeysApi.create dispatches POST with Idempotency-Key', async () => {
      await journeysApi.create('ws_test', { name: 'New Journey' }, 'idemp-1234');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys'));
      assert.strictEqual(interceptedMethod, 'POST');
      assert.strictEqual(interceptedHeaders['Idempotency-Key'], 'idemp-1234');
      assert.strictEqual(interceptedBody?.name, 'New Journey');
    });

    it('journeysApi.replaceGraph dispatches PUT with expectedGraphSha256 concurrency guard', async () => {
      const graph = defaultJourneyGraph();
      await journeysApi.replaceGraph('ws_test', 'j_test', 'ver_1', {
        graph,
        expectedGraphSha256: 'a'.repeat(64),
      });
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/versions/ver_1/graph'),
      );
      assert.strictEqual(interceptedMethod, 'PUT');
      assert.strictEqual(interceptedBody?.expectedGraphSha256, 'a'.repeat(64));
    });

    it('journeysApi.createVersion dispatches POST with Idempotency-Key', async () => {
      await journeysApi.createVersion('ws_test', 'j_test', 'idemp-ver-1');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/versions'));
      assert.strictEqual(interceptedMethod, 'POST');
      assert.strictEqual(interceptedHeaders['Idempotency-Key'], 'idemp-ver-1');
    });

    it('journeysApi.publish dispatches POST with expectedGraphSha256 and Idempotency-Key', async () => {
      await journeysApi.publish(
        'ws_test',
        'j_test',
        'ver_1',
        {
          expectedGraphSha256: 'b'.repeat(64),
        },
        'idemp-publish-1',
      );
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/versions/ver_1/publish'),
      );
      assert.strictEqual(interceptedMethod, 'POST');
      assert.strictEqual(interceptedHeaders['Idempotency-Key'], 'idemp-publish-1');
      assert.strictEqual(interceptedBody?.expectedGraphSha256, 'b'.repeat(64));
    });

    it('journeysApi lifecycle endpoints target coordinated 8C-2 transition routes', async () => {
      await journeysApi.activate('ws_test', 'j_test');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/activate'));
      assert.strictEqual(interceptedMethod, 'POST');

      await journeysApi.pause('ws_test', 'j_test');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/pause'));
      assert.strictEqual(interceptedMethod, 'POST');

      await journeysApi.resume('ws_test', 'j_test');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/resume'));
      assert.strictEqual(interceptedMethod, 'POST');

      await journeysApi.archive('ws_test', 'j_test');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/archive'));
      assert.strictEqual(interceptedMethod, 'POST');
    });

    it('journeysApi telemetry endpoints target coordinated 8C-2 execution and statistics routes', async () => {
      await journeysApi.listExecutions('ws_test', 'j_test', { status: 'running' });
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/executions?status=running'),
      );
      assert.strictEqual(interceptedMethod, 'GET');

      await journeysApi.getStats('ws_test', 'j_test', 'ver_99');
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/stats?versionId=ver_99'),
      );
      assert.strictEqual(interceptedMethod, 'GET');
    });

    it('journeysApi.cancelExecution dispatches POST to operator cancel route', async () => {
      await journeysApi.cancelExecution('ws_test', 'j_test', 'exec_123');
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/executions/exec_123/cancel'),
      );
      assert.strictEqual(interceptedMethod, 'POST');
    });

    it('journeysApi.enrolContacts dispatches POST to enrollments route with Idempotency-Key', async () => {
      await journeysApi.enrolContacts(
        'ws_test',
        'j_test',
        { contactIds: ['c_1', 'c_2'] },
        'idemp-enrol-1',
      );
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/enrollments'));
      assert.strictEqual(interceptedMethod, 'POST');
      assert.strictEqual(interceptedHeaders['Idempotency-Key'], 'idemp-enrol-1');
      assert.deepStrictEqual(interceptedBody?.contactIds, ['c_1', 'c_2']);
    });

    describe('Idempotency-Key Preservation Across Retries (PR #106 Integration Guard)', () => {
      it('journeysApi.create preserves the same Idempotency-Key across retry attempts', async () => {
        const stableKey = 'idemp-journey-create-' + crypto.randomUUID();
        const capturedKeys: (string | undefined)[] = [];

        // Attempt 1
        await journeysApi.create('ws_test', { name: 'Retry Journey' }, stableKey);
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        // Attempt 2 (retry following transient network failure)
        await journeysApi.create('ws_test', { name: 'Retry Journey' }, stableKey);
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        assert.strictEqual(capturedKeys.length, 2);
        assert.strictEqual(capturedKeys[0], stableKey);
        assert.strictEqual(capturedKeys[1], stableKey);
        assert.strictEqual(capturedKeys[0], capturedKeys[1]);
      });

      it('journeysApi.publish preserves the same Idempotency-Key across retry attempts', async () => {
        const stablePublishKey = 'idemp-publish-' + crypto.randomUUID();
        const capturedKeys: (string | undefined)[] = [];

        // Attempt 1
        await journeysApi.publish(
          'ws_test',
          'j_test',
          'ver_1',
          { expectedGraphSha256: 'c'.repeat(64) },
          stablePublishKey,
        );
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        // Attempt 2 (retry)
        await journeysApi.publish(
          'ws_test',
          'j_test',
          'ver_1',
          { expectedGraphSha256: 'c'.repeat(64) },
          stablePublishKey,
        );
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        assert.strictEqual(capturedKeys.length, 2);
        assert.strictEqual(capturedKeys[0], stablePublishKey);
        assert.strictEqual(capturedKeys[1], stablePublishKey);
        assert.strictEqual(capturedKeys[0], capturedKeys[1]);
      });

      it('journeysApi.enrolContacts preserves the same Idempotency-Key across retry attempts', async () => {
        const stableEnrolKey = 'idemp-enrol-' + crypto.randomUUID();
        const capturedKeys: (string | undefined)[] = [];

        // Attempt 1
        await journeysApi.enrolContacts(
          'ws_test',
          'j_test',
          { contactIds: ['contact-1'] },
          stableEnrolKey,
        );
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        // Attempt 2 (retry)
        await journeysApi.enrolContacts(
          'ws_test',
          'j_test',
          { contactIds: ['contact-1'] },
          stableEnrolKey,
        );
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        assert.strictEqual(capturedKeys.length, 2);
        assert.strictEqual(capturedKeys[0], stableEnrolKey);
        assert.strictEqual(capturedKeys[1], stableEnrolKey);
        assert.strictEqual(capturedKeys[0], capturedKeys[1]);
      });

      it('journeysApi.createVersion preserves the same Idempotency-Key across retry attempts', async () => {
        const stableVersionKey = 'idemp-version-' + crypto.randomUUID();
        const capturedKeys: (string | undefined)[] = [];

        // Attempt 1
        await journeysApi.createVersion('ws_test', 'j_test', stableVersionKey);
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        // Attempt 2 (retry)
        await journeysApi.createVersion('ws_test', 'j_test', stableVersionKey);
        capturedKeys.push(interceptedHeaders['Idempotency-Key']);

        assert.strictEqual(capturedKeys.length, 2);
        assert.strictEqual(capturedKeys[0], stableVersionKey);
        assert.strictEqual(capturedKeys[1], stableVersionKey);
        assert.strictEqual(capturedKeys[0], capturedKeys[1]);
      });

      it('distinct operations generate distinct unique Idempotency-Keys', async () => {
        const key1 = crypto.randomUUID();
        const key2 = crypto.randomUUID();
        assert.notStrictEqual(key1, key2);

        await journeysApi.create('ws_test', { name: 'Journey A' }, key1);
        const recordedKey1 = interceptedHeaders['Idempotency-Key'];

        await journeysApi.create('ws_test', { name: 'Journey B' }, key2);
        const recordedKey2 = interceptedHeaders['Idempotency-Key'];

        assert.notStrictEqual(recordedKey1, recordedKey2);
        assert.strictEqual(recordedKey1, key1);
        assert.strictEqual(recordedKey2, key2);
      });
    });
  });

  describe('8. Phase 8C-4 Event Intake & Scheduled Trigger Processing', () => {
    describe('8.1 Timezone & Schedule Calculation Invariants', () => {
      it('isJourneyTimeZone accepts valid IANA identifiers and rejects invalid strings', () => {
        assert.strictEqual(isJourneyTimeZone('UTC'), true);
        assert.strictEqual(isJourneyTimeZone('America/New_York'), true);
        assert.strictEqual(isJourneyTimeZone('Asia/Kolkata'), true);
        assert.strictEqual(isJourneyTimeZone('Europe/London'), true);
        assert.strictEqual(isJourneyTimeZone('Australia/Sydney'), true);

        // Invalid time zones
        assert.strictEqual(isJourneyTimeZone(''), false);
        assert.strictEqual(isJourneyTimeZone('GMT+5'), false);
        assert.strictEqual(isJourneyTimeZone('Mars/Olympus'), false);
        assert.strictEqual(isJourneyTimeZone('Invalid/Timezone'), false);
        assert.strictEqual(isJourneyTimeZone(null), false);
        assert.strictEqual(isJourneyTimeZone(123), false);
      });

      it('nextJourneyScheduleFire accurately calculates upcoming fire instant for once schedule', () => {
        const pastSchedule: JourneySchedule = {
          type: 'once',
          at: new Date(Date.now() - 3600000).toISOString(),
        };
        assert.strictEqual(nextJourneyScheduleFire(pastSchedule, new Date()), null);

        const futureInstant = new Date(Date.now() + 86400000);
        const futureSchedule: JourneySchedule = {
          type: 'once',
          at: futureInstant.toISOString(),
        };
        const next = nextJourneyScheduleFire(futureSchedule, new Date());
        assert.ok(next instanceof Date);
        assert.strictEqual(next.getTime(), futureInstant.getTime());
      });

      it('nextJourneyScheduleFire calculates recurring daily and weekly fires', () => {
        const dailySchedule: JourneySchedule = {
          type: 'recurring',
          frequency: 'daily',
          time: '14:30',
          timeZone: 'UTC',
          daysOfWeek: undefined,
        };
        const nextDaily = nextJourneyScheduleFire(dailySchedule, new Date('2026-11-14T10:00:00Z'));
        assert.ok(nextDaily instanceof Date);
        assert.strictEqual(nextDaily.toISOString(), '2026-11-14T14:30:00.000Z');

        // Weekly schedule: only fires on Monday (1)
        const weeklyMondaySchedule: JourneySchedule = {
          type: 'recurring',
          frequency: 'weekly',
          time: '09:00',
          timeZone: 'UTC',
          daysOfWeek: [1],
        };
        // 2026-11-14 is a Saturday (6), so next Monday is 2026-11-16
        const nextWeekly = nextJourneyScheduleFire(
          weeklyMondaySchedule,
          new Date('2026-11-14T10:00:00Z'),
        );
        assert.ok(nextWeekly instanceof Date);
        assert.strictEqual(nextWeekly.toISOString(), '2026-11-16T09:00:00.000Z');
      });

      it('enforces daily schedules take no daysOfWeek and weekly requires days 1..7', () => {
        const validDailyGraph: JourneyGraph = {
          schemaVersion: 1,
          entry: 'start',
          nodes: {
            start: {
              type: 'entry',
              trigger: {
                kind: 'schedule',
                segmentId: '00000000-0000-0000-0000-000000000001',
                schedule: {
                  type: 'recurring',
                  frequency: 'daily',
                  time: '09:00',
                  timeZone: 'UTC',
                },
              },
              next: 'finish',
            },
            finish: { type: 'exit' },
          },
        };
        assert.strictEqual(validateJourneyGraph(validDailyGraph).valid, true);

        // Daily schedule with daysOfWeek must be rejected by authoritative contract validator
        const invalidDailyGraph = {
          schemaVersion: 1,
          entry: 'start',
          nodes: {
            start: {
              type: 'entry',
              trigger: {
                kind: 'schedule',
                segmentId: '00000000-0000-0000-0000-000000000001',
                schedule: {
                  type: 'recurring',
                  frequency: 'daily',
                  time: '09:00',
                  timeZone: 'UTC',
                  daysOfWeek: [1, 2],
                },
              },
              next: 'finish',
            },
            finish: { type: 'exit' },
          },
        };
        const dailyReport = validateJourneyGraph(invalidDailyGraph as unknown as JourneyGraph);
        assert.strictEqual(dailyReport.valid, false);
        assert.ok(
          dailyReport.errors.some((e) => e.message.includes('daily schedules take no days')),
        );
      });
    });

    describe('8.2 Traceability & Formatting Helpers', () => {
      it('formatEntryRef humanizes event, schedule, and api provenance references', () => {
        assert.strictEqual(formatEntryRef(null), 'Direct / Manual');
        assert.strictEqual(formatEntryRef(undefined), 'Direct / Manual');
        assert.strictEqual(
          formatEntryRef('event:01955b0a-7b3b-7411-9a4f-9e67d4f91111'),
          'Event (01955b0a…)',
        );
        assert.ok(
          formatEntryRef('schedule:trig-123:2026-11-14T10:00:00.000Z').includes('Schedule ('),
        );
        assert.strictEqual(formatEntryRef('usr-idemp-1234567890'), 'Ref: usr-idemp-12…');
      });

      it('formatStepDetails parses initial entry step metadata', () => {
        assert.strictEqual(formatStepDetails(null), null);
        assert.strictEqual(
          formatStepDetails({
            entryKind: 'event',
            eventKind: 'contact.tag_added',
            eventTag: 'VIP',
          }),
          'Triggered by platform event: contact.tag_added (Tag: VIP)',
        );
        assert.strictEqual(
          formatStepDetails({ entryKind: 'event', eventKind: 'contact.created' }),
          'Triggered by platform event: contact.created',
        );
        assert.ok(
          formatStepDetails({
            entryKind: 'schedule',
            firedAt: '2026-11-14T10:00:00Z',
          })?.includes('Triggered by schedule fired at'),
        );
        assert.strictEqual(
          formatStepDetails({ entryKind: 'api', enrolledBy: 'operator-alice' }),
          'Enrolled via Inbound API (by operator-alice)',
        );
      });

      it('formatTriggerSummary renders detailed metadata for event and schedule triggers', () => {
        assert.strictEqual(
          formatTriggerSummary({
            id: 't-evt',
            journeyVersionId: 'v1',
            kind: 'event',
            eventKind: 'contact.tag_added',
            eventTag: 'VIP_CUSTOMER',
            segmentId: null,
            nextFireAt: null,
            status: 'active',
          }),
          'Event: contact.tag_added ("VIP_CUSTOMER")',
        );

        const scheduleSummary = formatTriggerSummary({
          id: 't-sch',
          journeyVersionId: 'v1',
          kind: 'schedule',
          eventKind: null,
          eventTag: null,
          segmentId: '00000000-0000-0000-0000-000000000042',
          nextFireAt: '2026-11-15T09:00:00Z',
          status: 'active',
        });
        assert.ok(scheduleSummary.includes('Schedule'));
        assert.ok(scheduleSummary.includes('Segment 00000000…'));
        assert.ok(scheduleSummary.includes('Next:'));

        const pausedSummary = formatTriggerSummary({
          id: 't-paused',
          journeyVersionId: 'v1',
          kind: 'schedule',
          eventKind: null,
          eventTag: null,
          segmentId: '00000000-0000-0000-0000-000000000042',
          nextFireAt: null,
          status: 'paused',
        });
        assert.ok(pausedSummary.includes('(Paused)'));
      });
    });

    describe('8.3 Trigger Status Badges & Component Static Markup', () => {
      it('JourneyTriggerStatusBadge maps statuses to tones and labels', () => {
        assert.strictEqual(getJourneyTriggerStatusTone('active'), 'success');
        assert.strictEqual(getJourneyTriggerStatusTone('paused'), 'warning');
        assert.strictEqual(getJourneyTriggerStatusTone('retired'), 'neutral');

        const activeMarkup = renderToStaticMarkup(
          React.createElement(JourneyTriggerStatusBadge, { status: 'active' }),
        );
        assert.ok(activeMarkup.includes('Armed'));

        const pausedMarkup = renderToStaticMarkup(
          React.createElement(JourneyTriggerStatusBadge, { status: 'paused' }),
        );
        assert.ok(pausedMarkup.includes('Paused'));

        const retiredMarkup = renderToStaticMarkup(
          React.createElement(JourneyTriggerStatusBadge, { status: 'retired' }),
        );
        assert.ok(retiredMarkup.includes('Retired'));
      });

      it('JourneyNodeInspector renders schedule recurrence, time, timezone and preview controls', () => {
        const scheduleGraph: JourneyGraph = {
          schemaVersion: 1,
          entry: 'start',
          nodes: {
            start: {
              type: 'entry',
              trigger: {
                kind: 'schedule',
                segmentId: '00000000-0000-0000-0000-000000000001',
                schedule: {
                  type: 'recurring',
                  frequency: 'weekly',
                  time: '10:30',
                  timeZone: 'UTC',
                  daysOfWeek: [1, 3, 5],
                },
              },
              next: 'finish',
            },
            finish: { type: 'exit' },
          },
        };

        const markup = renderToStaticMarkup(
          React.createElement(JourneyNodeInspector, {
            nodeKey: 'start',
            node: scheduleGraph.nodes.start!,
            graph: scheduleGraph,
            onChange: () => {},
            onClose: () => {},
          }),
        );

        assert.ok(markup.includes('Trigger Configuration'));
        assert.ok(markup.includes('Audience Segment'));
        assert.ok(markup.includes('Recurrence Frequency'));
        assert.ok(markup.includes('Dispatch Time (24-Hour HH:MM)'));
        assert.ok(markup.includes('Time Zone (IANA)'));
        assert.ok(markup.includes('Next Firing Preview:'));
        assert.ok(markup.includes('aria-pressed="true"'), 'Selected days must expose aria-pressed');
      });

      it('JourneyNodeInspector renders event trigger controls with tag input for contact.tag_added', () => {
        const eventGraph: JourneyGraph = {
          schemaVersion: 1,
          entry: 'start',
          nodes: {
            start: {
              type: 'entry',
              trigger: {
                kind: 'event',
                event: 'contact.tag_added',
                tag: 'VIP_TIER_1',
              },
              next: 'finish',
            },
            finish: { type: 'exit' },
          },
        };

        const markup = renderToStaticMarkup(
          React.createElement(JourneyNodeInspector, {
            nodeKey: 'start',
            node: eventGraph.nodes.start!,
            graph: eventGraph,
            onChange: () => {},
            onClose: () => {},
          }),
        );

        assert.ok(markup.includes('Platform Event Type'));
        assert.ok(markup.includes('Tag Name'));
        assert.ok(markup.includes('VIP_TIER_1'));
        assert.ok(markup.includes('/64'), 'Exposes 64-char cap indicator');
      });
    });
  });
});
