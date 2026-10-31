import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EnvironmentBadge } from './environment-badge';

(globalThis as unknown as { React: typeof React }).React = React;

describe('EnvironmentBadge (U11)', () => {
  it('1. renders null when env is production or empty', () => {
    assert.equal(
      renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: 'production' })),
      '',
    );
    assert.equal(renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: 'prod' })), '');
    assert.equal(renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: '' })), '');
  });

  it('2. renders QA badge with amber styling', () => {
    const html = renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: 'qa' }));
    assert.ok(html.includes('QA'));
    assert.ok(html.includes('border-amber-500/40'));
    assert.ok(html.includes('text-amber-300'));
    assert.ok(html.includes('title="Environment: qa"'));
  });

  it('3. renders Staging badge with indigo styling', () => {
    const html = renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: 'staging' }));
    assert.ok(html.includes('STAGING'));
    assert.ok(html.includes('border-indigo-500/40'));
    assert.ok(html.includes('text-indigo-300'));
  });

  it('4. renders DEV badge for development or local', () => {
    const htmlDev = renderToStaticMarkup(
      React.createElement(EnvironmentBadge, { env: 'development' }),
    );
    assert.ok(htmlDev.includes('DEV'));
    assert.ok(htmlDev.includes('border-sky-500/40'));

    const htmlLocal = renderToStaticMarkup(React.createElement(EnvironmentBadge, { env: 'local' }));
    assert.ok(htmlLocal.includes('DEV'));
  });
});
