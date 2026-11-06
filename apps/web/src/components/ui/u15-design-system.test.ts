import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Badge, StatusBadge } from './badge';
import { Breadcrumb, breadcrumbsFromPath } from './breadcrumb';
import { Button, IconButton } from './button';
import { DataTable, ariaSort, nextSort, type DataTableColumn } from './data-table';
import { handleDialogKeyDown, isExpandedCombobox } from './dialog-focus';
import { EmptyState } from './empty-state';
import { Input, PasswordInput, SearchInput } from './input';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  listboxKeyIntent,
  nextEnabledIndex,
  rovingIndex,
  typeaheadIndex,
} from './keyboard';
import { Select, computeMenuPosition, flattenOptions } from './select';
import { StatCard } from './stat-card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
import { ThemePreferenceControl } from './theme-preference-control';

(globalThis as unknown as { React: typeof React }).React = React;
const h = React.createElement;
/** createElement for components whose `children` prop is required (passed positionally). */
const hc = React.createElement as unknown as (
  type: unknown,
  props: unknown,
  ...children: unknown[]
) => React.ReactElement;
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const UI = __dirname;

describe('U15.1 Button', () => {
  it('renders each variant and size with token classes and a visible focus outline', () => {
    for (const variant of ['primary', 'secondary', 'outline', 'ghost', 'destructive'] as const) {
      for (const size of ['sm', 'md', 'lg'] as const) {
        const out = html(h(Button, { variant, size }, 'Save'));
        assert.match(out, /^<button type="button"/);
        assert.match(out, /focus-visible:outline-2/);
        assert.match(out, /focus-visible:outline-offset-2/);
        assert.match(out, /focus-visible:outline-acc-primary/);
      }
    }
    assert.match(
      html(h(Button, { variant: 'primary' }, 'x')),
      /bg-acc-primary text-acc-on-primary/,
    );
    assert.match(
      html(h(Button, { variant: 'destructive' }, 'x')),
      /bg-acc-destructive text-acc-on-destructive/,
    );
  });

  it('loading: disabled, aria-busy and a hidden spinner; text kept for the accessible name', () => {
    const out = html(h(Button, { loading: true }, 'Saving'));
    assert.match(out, /disabled=""/);
    assert.match(out, /aria-busy="true"/);
    assert.match(out, /<svg aria-hidden="true"/);
    assert.match(out, />Saving</);
  });

  it('icon buttons require and expose an accessible name', () => {
    const out = html(h(IconButton, { label: 'Close panel', icon: h('svg') }));
    assert.match(out, /aria-label="Close panel"/);
    assert.match(out, /size-\[38px\]/);
  });
});

describe('U15.1 inputs', () => {
  it('labels every input; error sets aria-invalid, role=alert message and aria-describedby (error, helper)', () => {
    const out = html(
      h(Input, {
        id: 'email',
        label: 'Email',
        helperText: 'Work address',
        error: 'Enter a valid email',
      }),
    );
    assert.match(out, /<label for="email"[^>]*>Email<\/label>/);
    assert.match(out, /aria-invalid="true"/);
    assert.match(out, /aria-describedby="email-error email-helper"/);
    assert.match(out, /<p id="email-error" role="alert"[^>]*>Enter a valid email<\/p>/);
    assert.match(out, /border-acc-error/);
  });

  it('valid input uses the >=3:1 input boundary token; hidden labels stay programmatic', () => {
    const out = html(h(Input, { id: 'q', label: 'Query', hideLabel: true }));
    assert.match(out, /border-acc-border-input/);
    assert.match(out, /class="[^"]*sr-only[^"]*"[^>]*>Query</);
    assert.doesNotMatch(out, /aria-invalid/);
  });

  it('password toggle is a keyboard-reachable toggle button (no tabindex=-1)', () => {
    const out = html(h(PasswordInput, { id: 'pw', label: 'Password' }));
    assert.match(out, /type="password"/);
    assert.match(out, /<button type="button" aria-label="Show password" aria-pressed="false"/);
    assert.doesNotMatch(out, /tabindex="-1"/);
  });

  it('search input is type=search with a decorative icon', () => {
    const out = html(h(SearchInput, { id: 's', label: 'Search messages' }));
    assert.match(out, /type="search"/);
    assert.match(out, /aria-hidden="true"/);
  });
});

describe('U15.1 Select', () => {
  const options = [
    { value: 'sms', label: 'SMS' },
    {
      label: 'Rich',
      items: [
        { value: 'rcs', label: 'RCS' },
        { value: 'wa', label: 'WhatsApp', disabled: true },
      ],
    },
  ];
  it('closed combobox markup: role, haspopup, expanded=false, labelled, value shown', () => {
    const out = html(
      h(Select, { id: 'ch', label: 'Channel', options, value: 'rcs', onValueChange: () => {} }),
    );
    assert.match(out, /role="combobox"/);
    assert.match(out, /aria-labelledby="ch-label"/);
    assert.match(out, /aria-haspopup="listbox"/);
    assert.match(out, /aria-expanded="false"/);
    assert.match(out, /aria-controls="ch-listbox"/);
    assert.match(out, />RCS</);
    assert.doesNotMatch(out, /aria-activedescendant/);
  });

  it('flattens groups in order; error state is announced', () => {
    assert.deepEqual(
      flattenOptions(options).map((o) => o.value),
      ['sms', 'rcs', 'wa'],
    );
    const out = html(
      h(Select, {
        id: 'c',
        label: 'C',
        options,
        value: null,
        onValueChange: () => {},
        error: 'Required',
      }),
    );
    assert.match(out, /aria-invalid="true"/);
    assert.match(out, /role="alert"[^>]*>Required/);
    assert.match(out, />Select…</);
  });

  it('collision handling: flips above when there is no room below, stays inside the viewport', () => {
    const vp = { width: 800, height: 600 };
    const below = computeMenuPosition({ top: 100, bottom: 138, left: 20, width: 240 }, vp, 200);
    assert.equal(below.placement, 'bottom');
    assert.equal(below.top, 142);
    const above = computeMenuPosition({ top: 520, bottom: 558, left: 700, width: 240 }, vp, 200);
    assert.equal(above.placement, 'top');
    assert.ok(above.top >= 8 && above.top + above.maxHeight <= 520);
    assert.ok(above.left + above.width <= 792, 'clamped to the right edge');
  });
});

describe('U15.1 keyboard logic', () => {
  const items = [
    { label: 'Alpha' },
    { label: 'Beta', disabled: true },
    { label: 'Bravo' },
    { label: 'Charlie' },
  ];
  it('moves skip disabled items and stop at the ends (wrap only when asked)', () => {
    assert.equal(nextEnabledIndex(items, 0, 1), 2);
    assert.equal(nextEnabledIndex(items, 3, 1), 3);
    assert.equal(nextEnabledIndex(items, 3, 1, true), 0);
    assert.equal(nextEnabledIndex(items, 2, -1), 0);
    assert.equal(firstEnabledIndex(items), 0);
    assert.equal(lastEnabledIndex(items), 3);
  });
  it('type-ahead matches prefixes, cycles on a repeated key and skips disabled', () => {
    assert.equal(typeaheadIndex(items, 'c', -1), 3);
    assert.equal(typeaheadIndex(items, 'b', 0), 2); // Beta is disabled
    assert.equal(typeaheadIndex(items, 'br', 2), 2);
    assert.equal(typeaheadIndex(items, 'aa', 0), 0);
    assert.equal(typeaheadIndex(items, 'z', 0), -1);
  });
  it('listbox intents follow the APG select-only combobox pattern', () => {
    assert.deepEqual(listboxKeyIntent('ArrowDown', items, -1, false), { type: 'open', index: 0 });
    assert.deepEqual(listboxKeyIntent('ArrowUp', items, -1, false), { type: 'open', index: 3 });
    assert.deepEqual(listboxKeyIntent('ArrowDown', items, 0, true), { type: 'move', index: 2 });
    assert.deepEqual(listboxKeyIntent('End', items, 0, true), { type: 'move', index: 3 });
    assert.deepEqual(listboxKeyIntent('Enter', items, 0, true), { type: 'select' });
    assert.deepEqual(listboxKeyIntent(' ', items, 0, true), { type: 'select' });
    assert.deepEqual(listboxKeyIntent('Escape', items, 0, true), { type: 'close' });
    assert.deepEqual(listboxKeyIntent('Tab', items, 0, true), { type: 'close' });
    assert.deepEqual(listboxKeyIntent('x', items, 0, true), { type: 'none' });
  });
  it('roving focus wraps; Home/End jump', () => {
    assert.equal(rovingIndex('ArrowRight', items, 3), 0);
    assert.equal(rovingIndex('ArrowLeft', items, 0), 3);
    assert.equal(rovingIndex('Home', items, 2), 0);
    assert.equal(rovingIndex('End', items, 0), 3);
    assert.equal(rovingIndex('ArrowDown', items, 0), -1);
    assert.equal(rovingIndex('ArrowDown', items, 0, 'both'), 2);
  });
});

describe('U15.1 Tabs', () => {
  it('tablist/tab/tabpanel wiring; only the selected tab is tabbable; inactive panel hidden', () => {
    const out = html(
      hc(
        Tabs,
        { defaultValue: 'a' },
        hc(
          TabsList,
          { label: 'Message views' },
          hc(TabsTrigger, { value: 'a' }, 'All'),
          hc(TabsTrigger, { value: 'b' }, 'Failed'),
        ),
        hc(TabsContent, { value: 'a' }, 'all-panel'),
        hc(TabsContent, { value: 'b' }, 'failed-panel'),
      ),
    );
    assert.match(out, /role="tablist" aria-label="Message views" aria-orientation="horizontal"/);
    const tabs = [
      ...out.matchAll(
        /<button type="button" role="tab" id="([^"]+)" aria-selected="(true|false)" aria-controls="([^"]+)" tabindex="(0|-1)"/g,
      ),
    ];
    assert.equal(tabs.length, 2);
    assert.deepEqual(
      tabs.map((t) => [t[2], t[4]]),
      [
        ['true', '0'],
        ['false', '-1'],
      ],
    );
    assert.match(
      out,
      new RegExp(`role="tabpanel" id="${tabs[0]![3]}" aria-labelledby="${tabs[0]![1]}"`),
    );
    assert.match(out, /all-panel/);
    assert.doesNotMatch(out, /failed-panel/);
    assert.match(out, /hidden=""/);
  });
});

describe('U15.1 Badge', () => {
  it('semantic variants use the refined text tokens on the subtle fills', () => {
    assert.match(
      html(h(Badge, { variant: 'success' }, 'ok')),
      /bg-acc-success-subtle text-acc-success-text/,
    );
    assert.match(
      html(h(Badge, { variant: 'warning' }, 'w')),
      /bg-acc-warning-subtle text-acc-warning-text/,
    );
    assert.match(
      html(h(Badge, { variant: 'error' }, 'e')),
      /bg-acc-error-subtle text-acc-error-text/,
    );
    assert.match(
      html(h(Badge, { variant: 'neutral' }, 'n')),
      /bg-acc-surface-raised text-acc-text-primary/,
    );
  });
  it('status badges never rely on colour alone: distinct glyph, visible text, screen-reader prefix', () => {
    const glyphs = new Set<string>();
    for (const variant of ['success', 'warning', 'error', 'accent', 'neutral'] as const) {
      const out = html(h(StatusBadge, { variant, label: 'Queued' }));
      assert.match(out, /<span class="sr-only">Status: <\/span>Queued/);
      glyphs.add(out.match(/<svg[\s\S]*?<\/svg>/)![0].replace(/class="[^"]*"/g, ''));
    }
    assert.equal(glyphs.size, 5, 'each status has its own shape');
  });
});

describe('U15.1 StatCard (no fabricated metrics)', () => {
  it('shows only the given value; loading, missing and error states are explicit', () => {
    assert.match(html(h(StatCard, { label: 'Messages today', value: 1234 })), />1,234</);
    const loading = html(
      h(StatCard, { label: 'Messages today', value: undefined, isLoading: true }),
    );
    assert.match(loading, /aria-busy="true"/);
    assert.match(loading, /Loading Messages today/);
    const empty = html(h(StatCard, { label: 'Messages today', value: null }));
    assert.match(empty, /<span aria-hidden="true">—<\/span><span class="sr-only">No data<\/span>/);
    assert.doesNotMatch(empty.replace(/<[^>]+>/g, ''), /\d/, 'no number is shown without data');
    assert.match(html(h(StatCard, { label: 'x', value: 5, error: true })), /Unavailable/);
  });
});

describe('U15.1 Breadcrumb', () => {
  it('derives items from a pathname, skips route groups, labels by segment or path', () => {
    const items = breadcrumbsFromPath(
      '/(console)/organizations/01a16d1b-a2da-72bd-8124-3c4b4471b9d5/members',
      {
        organizations: 'Organizations',
      },
    );
    assert.deepEqual(items, [
      { label: 'Home', href: '/' },
      { label: 'Organizations', href: '/organizations' },
      {
        label: '01a16d1b-a2da-72bd-8124-3c4b4471b9d5',
        href: '/organizations/01a16d1b-a2da-72bd-8124-3c4b4471b9d5',
      },
      { label: 'Members' },
    ]);
    assert.deepEqual(breadcrumbsFromPath('/'), [{ label: 'Home' }]);
  });
  it('nav landmark, current page marked, long names truncated with the full title', () => {
    const out = html(
      h(Breadcrumb, { items: breadcrumbsFromPath('/messages/very-long-message-identifier-value') }),
    );
    assert.match(out, /<nav aria-label="Breadcrumb"/);
    assert.match(out, /<a href="\/messages" title="Messages"/);
    assert.match(
      out,
      /aria-current="page" title="Very long message identifier value" class="[^"]*max-w-\[160px\] truncate/,
    );
  });
});

describe('U15.1 EmptyState and theme control', () => {
  it('empty state: heading, description, caller action, decorative graphic', () => {
    const out = html(
      h(EmptyState, {
        title: 'No messages yet',
        description: 'Send one to see it here.',
        action: h(Button, null, 'Send message'),
      }),
    );
    assert.match(out, /<h3[^>]*>No messages yet<\/h3>/);
    assert.match(out, /Send one to see it here\./);
    assert.match(out, /<span aria-hidden="true" class="mb-4 flex"><svg/);
    assert.match(out, />Send message</);
  });
  it('theme control is a radio group; server render shows System checked', () => {
    const out = html(h(ThemePreferenceControl));
    assert.match(out, /role="radiogroup" aria-label="Theme"/);
    const radios = [
      ...out.matchAll(
        /role="radio" aria-checked="(true|false)" tabindex="(0|-1)"[^>]*>(System|Light|Dark)</g,
      ),
    ];
    assert.deepEqual(
      radios.map((r) => [r[3], r[1], r[2]]),
      [
        ['System', 'true', '0'],
        ['Light', 'false', '-1'],
        ['Dark', 'false', '-1'],
      ],
    );
  });
});

describe('U15.1 DataTable (server-driven)', () => {
  type Row = { id: string; name: string; status: string };
  const columns: DataTableColumn<Row>[] = [
    { id: 'name', header: 'Name', cell: (r) => r.name, sortField: 'name' },
    { id: 'status', header: 'Status', cell: (r) => r.status },
  ];
  const base = {
    caption: 'Messages',
    columns,
    getRowKey: (r: Row) => r.id,
    queryState: { pageSize: 25, filters: {}, sortField: 'name', sortDirection: 'desc' as const },
    onQueryChange: () => {},
    emptyState: h(EmptyState, { title: 'Nothing here' }),
  };

  it('renders rows exactly as given (order preserved), caption, aria-sort on sortable columns only', () => {
    const data = [
      { id: '2', name: 'zeta', status: 'b' },
      { id: '1', name: 'alpha', status: 'a' },
    ];
    const out = html(h(DataTable<Row>, { ...base, data, isLoading: false }));
    assert.match(out, /<caption class="sr-only">Messages<\/caption>/);
    assert.ok(out.indexOf('zeta') < out.indexOf('alpha'), 'server order kept');
    assert.match(out, /<th scope="col" aria-sort="descending"/);
    assert.match(out, /<th scope="col" class="[^"]*">Status<\/th>/);
  });

  it('loading is aria-busy with skeleton rows; error is an alert; empty shows the caller empty state', () => {
    assert.match(
      html(h(DataTable<Row>, { ...base, data: [], isLoading: true })),
      /aria-busy="true"/,
    );
    assert.match(
      html(
        h(DataTable<Row>, {
          ...base,
          data: [],
          isLoading: false,
          error: new Error('Failed to load'),
        }),
      ),
      /role="alert"[^>]*>Failed to load/,
    );
    assert.match(html(h(DataTable<Row>, { ...base, data: [], isLoading: false })), /Nothing here/);
  });

  it('sorting is emitted for the server (ascending first, then toggling); pagination via cursors', () => {
    assert.deepEqual(nextSort({ sortField: 'name' }, {}), {
      sortField: 'name',
      sortDirection: 'asc',
    });
    assert.deepEqual(nextSort({ sortField: 'name' }, { sortField: 'name', sortDirection: 'asc' }), {
      sortField: 'name',
      sortDirection: 'desc',
    });
    assert.equal(nextSort({}, {}), null);
    assert.equal(ariaSort({ sortField: 'x' }, { sortField: 'y' }), 'none');
    assert.equal(ariaSort({}, {}), undefined);
  });

  it('source invariant: no client-side filter or sort in the table suite', () => {
    for (const file of fs.readdirSync(path.join(UI, 'data-table'))) {
      const src = fs.readFileSync(path.join(UI, 'data-table', file), 'utf8');
      assert.doesNotMatch(
        src,
        /\.(filter|sort|toSorted)\(/,
        `${file} must not filter or sort rows`,
      );
    }
  });
});

describe('U15.1 token discipline', () => {
  it('no hex colour values in U15.1 TypeScript components (tokens live only in globals.css)', () => {
    const files = [
      'button.tsx',
      'input.tsx',
      'select.tsx',
      'badge.tsx',
      'stat-card.tsx',
      'breadcrumb.tsx',
      'tabs.tsx',
      'empty-state.tsx',
      'drawer.tsx',
      'theme-preference-control.tsx',
      ...fs.readdirSync(path.join(UI, 'data-table')).map((f) => `data-table/${f}`),
    ];
    for (const file of files) {
      // Code only: documentation comments may cite the token values.
      const src = fs
        .readFileSync(path.join(UI, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(
        src,
        /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])/,
        `${file} contains a hard-coded colour`,
      );
      assert.doesNotMatch(src, /\b(rgb|hsl|oklch)\(/, `${file} contains a colour function`);
    }
  });
});

describe('U15.1 Select inside modal dialogs', () => {
  const key = (extra: Record<string, unknown> = {}) => {
    let stopped = false;
    return {
      event: {
        key: 'Escape',
        shiftKey: false,
        preventDefault() {},
        stopPropagation() {
          stopped = true;
        },
        ...extra,
      },
      stopped: () => stopped,
    };
  };
  const combobox = (expanded: boolean) => ({
    getAttribute: (n: string) =>
      n === 'role' ? 'combobox' : n === 'aria-expanded' ? String(expanded) : null,
  });
  it('Escape already handled by an open listbox does not dismiss the dialog', () => {
    let dismissed = 0;
    const opts = { dismissible: true, onDismiss: () => (dismissed += 1) };
    const handled = key({ defaultPrevented: true });
    assert.equal(handleDialogKeyDown(handled.event, null, null, opts), 'deferred-to-native-popup');
    const expanded = key({ target: combobox(true) });
    assert.equal(handleDialogKeyDown(expanded.event, null, null, opts), 'deferred-to-native-popup');
    assert.equal(dismissed, 0);
    const plain = key({ target: combobox(false) });
    assert.equal(handleDialogKeyDown(plain.event, null, null, opts), 'dismissed');
    assert.equal(dismissed, 1);
    assert.equal(isExpandedCombobox(combobox(true)), true);
    assert.equal(isExpandedCombobox({}), false);
  });
});
