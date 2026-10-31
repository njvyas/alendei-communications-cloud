import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TemplateEditDialog } from './template-edit-dialog';
import { TemplateDeleteDialog } from './template-delete-dialog';
import type { TemplateResponse } from '@acc/contracts';

(globalThis as unknown as { React: typeof React }).React = React;

function renderWithClient(ui: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

describe('Template Dialog Components (U9)', () => {
  const draftTemplate: TemplateResponse = {
    id: '01955b0a-7b3b-7411-9a4f-tpl000000001',
    orgId: '01955b0a-7b3b-7411-9a4f-org000000001',
    channelId: '01955b0a-7b3b-7411-9a4f-ch000000001',
    name: 'order_update_draft',
    body: 'Hi {{name}}, your order {{order_id}} is ready.',
    variables: ['name', 'order_id'],
    approvalStatus: 'draft',
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
  };

  const approvedTemplate: TemplateResponse = {
    ...draftTemplate,
    id: '01955b0a-7b3b-7411-9a4f-tpl000000002',
    name: 'order_update_approved',
    approvalStatus: 'approved',
  };

  it('1. TemplateEditDialog renders editable form for draft template', () => {
    const html = renderWithClient(
      React.createElement(TemplateEditDialog, {
        open: true,
        onOpenChange: () => {},
        template: draftTemplate,
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('Edit Message Template'));
    assert.ok(html.includes('order_update_draft'));
    assert.ok(html.includes('Hi {{name}}, your order {{order_id}} is ready.'));
    assert.ok(html.includes('Save Changes'));
    assert.ok(!html.includes('Template is Approved'));
  });

  it('2. TemplateEditDialog displays warning banner and disables inputs for approved template', () => {
    const html = renderWithClient(
      React.createElement(TemplateEditDialog, {
        open: true,
        onOpenChange: () => {},
        template: approvedTemplate,
      }),
    );

    assert.ok(html.includes('Template is Approved'));
    assert.ok(html.includes('Approved templates cannot be modified directly'));
    assert.ok(html.includes('disabled=""'));
    assert.ok(!html.includes('Save Changes'));
    assert.ok(html.includes('Close'));
  });

  it('3. TemplateEditDialog returns null when open is false or template is null', () => {
    const htmlClosed = renderWithClient(
      React.createElement(TemplateEditDialog, {
        open: false,
        onOpenChange: () => {},
        template: draftTemplate,
      }),
    );
    assert.equal(htmlClosed, '');

    const htmlNull = renderWithClient(
      React.createElement(TemplateEditDialog, {
        open: true,
        onOpenChange: () => {},
        template: null,
      }),
    );
    assert.equal(htmlNull, '');
  });

  it('4. TemplateDeleteDialog renders template details and danger confirmation', () => {
    const html = renderWithClient(
      React.createElement(TemplateDeleteDialog, {
        open: true,
        onOpenChange: () => {},
        template: draftTemplate,
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('Delete Message Template'));
    assert.ok(html.includes('order_update_draft'));
    assert.ok(html.includes('soft-delete the template'));
    assert.ok(html.includes('data-testid="confirm-delete-template-btn"'));
    assert.ok(html.includes('Delete Template'));
  });
});
