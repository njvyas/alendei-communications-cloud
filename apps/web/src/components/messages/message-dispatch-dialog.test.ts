import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageDispatchDialog } from './message-dispatch-dialog';
import type { ChannelView } from '@/lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;

function renderWithClient(ui: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

describe('MessageDispatchDialog Component', () => {
  const mockChannels: ChannelView[] = [
    {
      id: '01955b0a-7b3b-7411-9a4f-ch0000000001',
      code: 'whatsapp',
      displayName: 'WhatsApp Business',
      status: 'active',
      createdAt: '2026-10-15T10:00:00Z',
      updatedAt: '2026-10-15T10:00:00Z',
    },
    {
      id: '01955b0a-7b3b-7411-9a4f-ch0000000002',
      code: 'sms',
      displayName: 'Direct SMS',
      status: 'active',
      createdAt: '2026-10-15T10:00:00Z',
      updatedAt: '2026-10-15T10:00:00Z',
    },
    {
      id: '01955b0a-7b3b-7411-9a4f-ch0000000003',
      code: 'rcs',
      displayName: 'Google RCS Business',
      status: 'active',
      createdAt: '2026-10-15T10:00:00Z',
      updatedAt: '2026-10-15T10:00:00Z',
    },
  ];

  it('1. renders modal dialog with channel selector and E.164 recipient input', () => {
    const html = renderWithClient(
      React.createElement(MessageDispatchDialog, {
        open: true,
        onOpenChange: () => {},
        channels: mockChannels,
        initialChannelCode: 'whatsapp',
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('id="message-dispatch-title"'));
    assert.ok(html.includes('Dispatch Message'));
    assert.ok(html.includes('id="dispatch-channel"'));
    assert.ok(html.includes('WhatsApp Business'));
    assert.ok(html.includes('Direct SMS'));
    assert.ok(html.includes('Google RCS Business'));
    assert.ok(html.includes('id="dispatch-recipient"'));
    assert.ok(html.includes('+12025550199'));
  });

  it('2. renders WhatsApp template and custom text radio options', () => {
    const html = renderWithClient(
      React.createElement(MessageDispatchDialog, {
        open: true,
        onOpenChange: () => {},
        channels: mockChannels,
        initialChannelCode: 'whatsapp',
      }),
    );

    assert.ok(html.includes('Dispatch Mode'));
    assert.ok(html.includes('Approved Template'));
    assert.ok(html.includes('Custom Text'));
  });

  it('3. renders SMS DLT metadata inputs when channel is SMS', () => {
    const html = renderWithClient(
      React.createElement(MessageDispatchDialog, {
        open: true,
        onOpenChange: () => {},
        channels: mockChannels,
        initialChannelCode: 'sms',
      }),
    );

    assert.ok(html.includes('SMS Body'));
    assert.ok(html.includes('DLT Telecommunications Metadata (Optional / India Telecom)'));
    assert.ok(html.includes('id="dlt-entity-id"'));
    assert.ok(html.includes('id="dlt-template-id"'));
    assert.ok(html.includes('id="dlt-header-id"'));
  });

  it('4. renders null when open is false', () => {
    const html = renderWithClient(
      React.createElement(MessageDispatchDialog, {
        open: false,
        onOpenChange: () => {},
        channels: mockChannels,
      }),
    );

    assert.equal(html, '');
  });
});
