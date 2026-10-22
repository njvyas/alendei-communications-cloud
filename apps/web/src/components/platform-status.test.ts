import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PlatformStatus } from './platform-status';
import OverviewPage from '../app/(console)/page';

// Ensure React is globally available
(globalThis as unknown as { React: typeof React }).React = React;

describe('PlatformStatus & Overview Health Card Behavior', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_ENV;
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options?: RequestInit }[] = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, options: init });
      return new Response(JSON.stringify({ status: 'ok', info: { postgres: { status: 'up' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  });

  const renderWithQueryClient = (ui: React.ReactElement, queryClient?: QueryClient) => {
    const client =
      queryClient ??
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
          },
        },
      });
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, ui));
  };

  it('renders null in staging environment and does not issue the blocked probe', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'staging';

    const html = renderWithQueryClient(React.createElement(PlatformStatus));
    assert.equal(html, '', 'PlatformStatus must render empty in staging');
    assert.equal(
      fetchCalls.length,
      0,
      'No health check probe must be dispatched when not in development',
    );
  });

  it('renders null in production environment and does not issue the blocked probe', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';

    const html = renderWithQueryClient(React.createElement(PlatformStatus));
    assert.equal(html, '', 'PlatformStatus must render empty in production');
    assert.equal(
      fetchCalls.length,
      0,
      'No health check probe must be dispatched when not in development',
    );
  });

  it('OverviewPage omits PlatformStatus and sm:grid-cols-2 in staging environment', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'staging';

    const html = renderWithQueryClient(React.createElement(OverviewPage));
    assert.doesNotMatch(html, /Platform status/);
    assert.doesNotMatch(html, /sm:grid-cols-2/);
    assert.match(html, /Phase 1 &amp; 2 — Foundation &amp; Infrastructure/);
    assert.equal(fetchCalls.length, 0);
  });

  it('OverviewPage omits PlatformStatus and sm:grid-cols-2 in production environment', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'production';

    const html = renderWithQueryClient(React.createElement(OverviewPage));
    assert.doesNotMatch(html, /Platform status/);
    assert.doesNotMatch(html, /sm:grid-cols-2/);
    assert.match(html, /Phase 1 &amp; 2 — Foundation &amp; Infrastructure/);
    assert.equal(fetchCalls.length, 0);
  });

  it('renders PlatformStatus and sm:grid-cols-2 on OverviewPage in development environment', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'development';

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(['health'], {
      status: 'ok',
      info: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });

    const html = renderWithQueryClient(React.createElement(OverviewPage), client);
    assert.match(html, /Platform status/);
    assert.match(html, /sm:grid-cols-2/);
    assert.match(html, /Readiness of the Phase 1 dependencies/);
    assert.match(html, /postgres/);
    assert.match(html, /redis/);
  });

  it('displays neutral error message and no misleading developer instructions upon failure', () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'development';

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const query = client.getQueryCache().build(client, { queryKey: ['health'] });
    query.setState({
      status: 'error',
      error: new Error('Health check failed with status 503'),
      data: null,
      dataUpdatedAt: Date.now(),
      errorUpdatedAt: Date.now(),
      fetchStatus: 'idle',
    });

    const html = renderWithQueryClient(React.createElement(PlatformStatus), client);
    assert.match(html, /Platform status is currently unavailable\./);
    assert.doesNotMatch(html, /npm run dev/i, 'Must NOT contain misleading developer instructions');
    assert.doesNotMatch(
      html,
      /The API is unreachable/i,
      'Must NOT contain misleading developer-only wording',
    );
    assert.match(html, /Health check failed with status 503/);
  });
});
