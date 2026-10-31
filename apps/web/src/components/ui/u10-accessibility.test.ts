import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import { AccessibleDialog } from './dialog';
import { ActionFeedback } from './action-feedback';
import { CircuitPolicyDialog } from '../providers/circuit-policy-dialog';
import { ProviderCreateDialog } from '../providers/provider-create-dialog';
import { ProviderHealthOverrideDialog } from '../providers/provider-health-override-dialog';
import { ProviderHealthProbeDialog } from '../providers/provider-health-probe-dialog';
import { ProviderTransitionDialog } from '../providers/provider-transition-dialog';
import { createAppQueryClient } from '../../lib/query-client';
import type { ProviderDetailView } from '../../lib/api-client';
import AuditLogsPage from '../../app/(console)/audit-logs/page';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

const SRC_ROOT = path.resolve(__dirname, '../..');

function withQueryClient(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: createAppQueryClient() }, node),
  );
}

/** Asserts the markup contains a modal dialog whose accessible name resolves to `name`. */
function assertNamedModal(html: string, name: RegExp): void {
  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/);
  assert.ok(dialog, 'expected an element with role="dialog"');
  assert.match(dialog[0], /aria-modal="true"/);
  const labelledBy = dialog[0].match(/aria-labelledby="([^"]+)"/);
  assert.ok(labelledBy?.[1], 'dialog must reference its title with aria-labelledby');
  const title = html.match(
    new RegExp(`<h[1-6][^>]*id="${labelledBy[1]}"[^>]*>([\\s\\S]*?)</h[1-6]>`),
  );
  assert.ok(title, `title element with id="${labelledBy[1]}" must exist`);
  assert.match(title[1]!.replace(/<[^>]+>/g, ''), name);
  assert.match(dialog[0], /tabindex="-1"/, 'overlay must keep backdrop focus inside the dialog');
}

const PROVIDER: ProviderDetailView = {
  id: '01955b0a-7b3b-7411-9a4f-pr0000000001',
  channelId: '01955b0a-7b3b-7411-9a4f-ch0000000001',
  channelCode: 'whatsapp',
  name: 'QA WhatsApp Simulator',
  adapterKey: 'simulator',
  status: 'active',
  healthState: 'healthy',
  healthOverride: null,
  healthChangedAt: null,
  circuitState: 'closed',
  circuitChangedAt: null,
  circuitCooldownUntil: null,
  capabilities: [],
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
};
const noop = () => {};

describe('U10 dialog accessible naming and semantics', () => {
  it('AccessibleDialog renders a named modal dialog with description', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AccessibleDialog,
        { isOpen: true, onClose: noop, titleId: 't1', descriptionId: 'd1' },
        React.createElement('h2', { id: 't1' }, 'Example Title'),
        React.createElement('p', { id: 'd1' }, 'Example description'),
      ),
    );
    assertNamedModal(html, /Example Title/);
    assert.match(html, /aria-describedby="d1"/);
  });

  it('AccessibleDialog renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      React.createElement(AccessibleDialog, { isOpen: false, onClose: noop, titleId: 't1' }),
    );
    assert.equal(html, '');
  });

  const providerDialogs: ReadonlyArray<[string, React.ReactElement, RegExp]> = [
    [
      'CircuitPolicyDialog',
      React.createElement(CircuitPolicyDialog, { open: true, onOpenChange: noop }),
      /circuit/i,
    ],
    [
      'ProviderCreateDialog',
      React.createElement(ProviderCreateDialog, { open: true, onOpenChange: noop }),
      /Create Provider/,
    ],
    [
      'ProviderHealthOverrideDialog',
      React.createElement(ProviderHealthOverrideDialog, {
        open: true,
        onOpenChange: noop,
        provider: PROVIDER,
      }),
      /\S/,
    ],
    [
      'ProviderHealthProbeDialog',
      React.createElement(ProviderHealthProbeDialog, {
        open: true,
        onOpenChange: noop,
        provider: PROVIDER,
      }),
      /\S/,
    ],
    [
      'ProviderTransitionDialog',
      React.createElement(ProviderTransitionDialog, {
        open: true,
        onOpenChange: noop,
        provider: PROVIDER,
        transition: 'disable',
      }),
      /\S/,
    ],
  ];

  for (const [label, element, name] of providerDialogs) {
    it(`${label} is a named modal dialog (previously had no dialog semantics)`, () => {
      assertNamedModal(withQueryClient(element), name);
    });
  }
});

describe('U10 status and error announcements', () => {
  it('announces errors with role="alert"', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionFeedback, { feedback: { type: 'error', message: 'Failed' } }),
    );
    assert.match(html, /role="alert"/);
  });

  it('announces success politely with role="status"', () => {
    const html = renderToStaticMarkup(
      React.createElement(ActionFeedback, { feedback: { type: 'success', message: 'Saved' } }),
    );
    assert.match(html, /role="status"/);
    assert.match(html, /aria-live="polite"/);
  });
});

describe('U10 rendered filter state and input labelling (Audit Logs page)', () => {
  const html = withQueryClient(React.createElement(AuditLogsPage));

  it('marks only the active outcome filter as pressed', () => {
    const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)/g)].map(
      (m) => [m[2]!.trim(), m[1]] as const,
    );
    assert.deepEqual(buttons, [
      ['All', 'true'],
      ['Success', 'false'],
      ['Denied', 'false'],
      ['Failure', 'false'],
    ]);
  });

  it('associates every visible filter label with its control', () => {
    for (const id of [
      'audit-actor-filter',
      'audit-occurred-from',
      'audit-occurred-to',
      'audit-sort',
    ]) {
      assert.match(html, new RegExp(`<label[^>]*for="${id}"`), `label for ${id}`);
      assert.match(html, new RegExp(`<(select|input)[^>]*id="${id}"`), `control ${id}`);
    }
    for (const name of ['Action key', 'Resource type', 'Correlation ID']) {
      assert.match(html, new RegExp(`<input[^>]*aria-label="${name}"`), name);
    }
  });
});

// ---------------------------------------------------------------------------
// Source sweep: regression guards so new console code keeps the U10 baseline.
// ---------------------------------------------------------------------------

function listTsx(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsx(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const SOURCES = listTsx(SRC_ROOT).map((file) => ({
  file: path.relative(SRC_ROOT, file),
  text: fs.readFileSync(file, 'utf8'),
}));

/** Returns each JSX opening tag of the given element names, with its line number. */
function openingTags(
  text: string,
  names: string,
): Array<{ tag: string; line: number; at: number }> {
  const out: Array<{ tag: string; line: number; at: number }> = [];
  const re = new RegExp(`<(${names})\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    let i = m.index;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({
      tag: text.slice(m.index, i + 1),
      line: text.slice(0, m.index).split('\n').length,
      at: m.index,
    });
  }
  return out;
}

describe('U10 source sweep', () => {
  it('every modal overlay has dialog semantics, a resolvable title and shared focus management', () => {
    const problems: string[] = [];
    for (const { file, text } of SOURCES) {
      if (!text.includes('fixed inset-0')) continue;
      for (const { tag, line } of openingTags(text, 'div')) {
        if (!tag.includes('fixed inset-0')) continue;
        const where = `${file}:${line}`;
        if (!tag.includes('role="dialog"')) problems.push(`${where} missing role="dialog"`);
        if (!tag.includes('aria-modal="true"')) problems.push(`${where} missing aria-modal`);
        const labelledBy = tag.match(/aria-labelledby=(?:"([^"]+)"|\{titleId\})/);
        if (!labelledBy) problems.push(`${where} missing aria-labelledby`);
        else if (labelledBy[1] && !text.includes(`id="${labelledBy[1]}"`))
          problems.push(`${where} aria-labelledby="${labelledBy[1]}" has no matching id`);
        if (!/overlayProps\(/.test(tag)) problems.push(`${where} not wired to useModalDialog`);
      }
      if (!file.endsWith(path.join('ui', 'dialog.tsx')) && !text.includes('panelRef}'))
        problems.push(`${file} dialog panel not attached to panelRef`);
    }
    assert.deepEqual(problems, []);
  });

  it('all 35 custom dialog panels are programmatically focusable (tabIndex={-1})', () => {
    const panels: string[] = [];
    const missing: string[] = [];
    for (const { file, text } of SOURCES) {
      if (file.endsWith(path.join('ui', 'dialog.tsx'))) continue;
      for (const { tag, line } of openingTags(text, 'div')) {
        if (!/ref=\{\w+\.panelRef\}/.test(tag)) continue;
        panels.push(`${file}:${line}`);
        if (!/tabIndex=\{-1\}/.test(tag)) missing.push(`${file}:${line}`);
      }
    }
    assert.equal(panels.length, 35);
    assert.deepEqual(missing, []);
  });

  it('dialog keyboard handling is not also bound through React onKeyDown (no double handling)', () => {
    const dialogSource = SOURCES.find(({ file }) => file.endsWith(path.join('ui', 'dialog.tsx')));
    assert.ok(dialogSource);
    assert.doesNotMatch(dialogSource.text, /onKeyDown/);
    assert.match(dialogSource.text, /attachModalKeyboard\(/);
    const overlaysWithKeyDown = SOURCES.flatMap(({ file, text }) =>
      openingTags(text, 'div')
        .filter(({ tag }) => tag.includes('role="dialog"') && tag.includes('onKeyDown'))
        .map(({ line }) => `${file}:${line}`),
    );
    assert.deepEqual(overlaysWithKeyDown, []);
  });

  it('static table content is not marked as a live region', () => {
    const templates = SOURCES.find(({ file }) =>
      file.endsWith(path.join('(console)', 'templates', 'page.tsx')),
    );
    assert.ok(templates);
    assert.doesNotMatch(templates.text, /role="status">\{tpl\.name\}/);
    assert.match(templates.text, /<span role="status">Loading templates…<\/span>/);
  });

  it('every table header cell declares its scope', () => {
    const missing = SOURCES.flatMap(({ file, text }) =>
      openingTags(text, 'th')
        .filter(({ tag }) => !/\bscope=/.test(tag))
        .map(({ line }) => `${file}:${line}`),
    );
    assert.deepEqual(missing, []);
  });

  it('every form control has a programmatic label', () => {
    const missing: string[] = [];
    for (const { file, text } of SOURCES) {
      for (const { tag, line, at } of openingTags(text, 'input|select|textarea')) {
        if (/type="hidden"/.test(tag)) continue;
        if (/aria-label(ledby)?=/.test(tag)) continue;
        const id = tag.match(/\bid=(?:"([^"]+)"|\{([^}]+)\})/);
        const idValue = id?.[1] ?? id?.[2];
        if (
          idValue &&
          (text.includes(`htmlFor="${idValue}"`) || text.includes(`htmlFor={${idValue}}`))
        )
          continue;
        // A control passed an `id` prop is labelled by its caller (e.g. SimulatorBehaviorSelector).
        if (id?.[2] === 'id') continue;
        const before = text.slice(0, at);
        if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;
        missing.push(`${file}:${line}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('filter toggle buttons expose their pressed state', () => {
    const missing: string[] = [];
    const toggle = /onClick=\{\(\) => (handle(Status|Outcome|Filter)Change|setExpiryPreset)\(/;
    for (const { file, text } of SOURCES) {
      for (const { tag, line } of openingTags(text, 'button')) {
        if (toggle.test(tag) && !/aria-pressed=\{/.test(tag)) missing.push(`${file}:${line}`);
      }
    }
    assert.deepEqual(missing, []);
    const pressed = SOURCES.filter(({ text }) => text.includes('aria-pressed={')).length;
    assert.ok(
      pressed >= 7,
      `expected aria-pressed on the console filter groups, found ${pressed} files`,
    );
  });

  it('error and loading containers use alert / status semantics', () => {
    const missing: string[] = [];
    const rules: Array<[RegExp, string]> = [
      [/\{(?:!?\w+ && )?\(?\w*[Ee]rror(?:Message)?\w*\)? && \(?\s*<(div|p)\b/g, 'role="alert"'],
      [/(?:\? |\{|: )(?:error|\w+Error) \? \(\s*<(div|p)\b/g, 'role="alert"'],
      [/(?:\{|\? |: )(?:isLoading|\w+Loading) (?:\?|&&) \(\s*<(div|p|span)\b/g, 'role="status"'],
    ];
    for (const { file, text } of SOURCES) {
      for (const [re, role] of rules) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const tag = openingTags(text.slice(m.index + m[0].length - m[1]!.length - 1), m[1]!)[0]
            ?.tag;
          if (tag && !tag.includes('role=')) {
            missing.push(`${file}:${text.slice(0, m.index).split('\n').length} needs ${role}`);
          }
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
