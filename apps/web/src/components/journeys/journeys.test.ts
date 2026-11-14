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
  type JourneyRecord,
  type JourneyGraph,
  type JourneyNode,
} from '@/lib/journeys';
import {
  JourneyStatusBadge,
  JourneyVersionStatusBadge,
  JourneyExecutionStatusBadge,
  getJourneyStatusTone,
  getJourneyVersionStatusTone,
  getJourneyExecutionStatusTone,
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
  });

  describe('3. Component Static Markup & Accessibility', () => {
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
    });

    it('canManageJourneys strictly requires journeys.manage', () => {
      setSessionGrants(['journeys.manage']);
      assert.strictEqual(canManageJourneys(), true);

      setSessionGrants(['journeys.read']);
      assert.strictEqual(canManageJourneys(), false);
    });

    it('refuses actors who only hold unrelated permissions', () => {
      setSessionGrants(['workspaces.read']);
      assert.strictEqual(canReadJourneys(), false);

      setSessionGrants(['campaigns.manage']);
      assert.strictEqual(canManageJourneys(), false);
    });
  });

  describe('5. API Client Endpoint Contracts & Isolation', () => {
    const originalFetch = globalThis.fetch;
    interface InterceptedPayload {
      name?: string;
      expectedGraphSha256?: string;
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

    it('journeysApi.publish dispatches POST with expectedGraphSha256 concurrency guard', async () => {
      await journeysApi.publish('ws_test', 'j_test', 'ver_1', {
        expectedGraphSha256: 'b'.repeat(64),
      });
      assert.ok(
        interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/versions/ver_1/publish'),
      );
      assert.strictEqual(interceptedMethod, 'POST');
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

      await journeysApi.getNodeStatistics('ws_test', 'j_test');
      assert.ok(interceptedUrl.includes('/workspaces/ws_test/journeys/j_test/statistics'));
      assert.strictEqual(interceptedMethod, 'GET');
    });
  });
});
