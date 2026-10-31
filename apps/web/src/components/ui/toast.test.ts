import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToastCard } from './toast';
import type { ToastItem } from '@/lib/toast';

(globalThis as unknown as { React: typeof React }).React = React;

describe('Toast Components (U6)', () => {
  it('1. ToastCard renders success toast with role="status" and title', () => {
    const item: ToastItem = {
      id: 'test-1',
      type: 'success',
      title: 'Suppression Added',
      message: 'Address has been added to suppression list.',
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(React.createElement(ToastCard, { item }));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes('Suppression Added'));
    assert.ok(html.includes('Address has been added to suppression list.'));
    assert.ok(html.includes('border-emerald-500/30'));
    assert.ok(html.includes('bg-emerald-500'));
    assert.ok(html.includes('aria-label="Dismiss notification"'));
  });

  it('2. ToastCard renders error toast with role="alert" and assertive live region', () => {
    const item: ToastItem = {
      id: 'test-2',
      type: 'error',
      title: 'Validation Failed',
      message: 'Required field is missing.',
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(React.createElement(ToastCard, { item }));
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('aria-live="assertive"'));
    assert.ok(html.includes('Validation Failed'));
    assert.ok(html.includes('border-rose-500/30'));
    assert.ok(html.includes('bg-rose-500'));
  });

  it('3. ToastCard renders info toast with sky styling', () => {
    const item: ToastItem = {
      id: 'test-3',
      type: 'info',
      title: 'System Notice',
      message: 'Scheduled backup underway.',
      createdAt: Date.now(),
    };

    const html = renderToStaticMarkup(React.createElement(ToastCard, { item }));
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes('System Notice'));
    assert.ok(html.includes('border-sky-500/30'));
    assert.ok(html.includes('bg-sky-500'));
  });
});
