import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { build } from 'esbuild';
import postcss from 'postcss';
import { expect, test, type Page } from '@playwright/test';

import { THEME_PRE_PAINT_SCRIPT } from '../../src/lib/theme';

/**
 * U15.1 component validation in real browsers (Chromium and Firefox): keyboard
 * interaction, ARIA state, visible focus, rendered contrast in both themes, and
 * visual snapshots (Chromium). The harness is bundled from production sources and
 * the stylesheet is the real globals.css compiled with Tailwind.
 */

const ORIGIN = 'http://u15.test';
const WEB_ROOT = path.resolve(__dirname, '../..');
let bundle = '';
let css = '';

test.beforeAll(async () => {
  const js = await build({
    entryPoints: [path.join(__dirname, 'harness.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    tsconfig: path.join(WEB_ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process = { env: {} };' },
    logLevel: 'silent',
  });
  bundle = js.outputFiles[0]!.text;
  const globals = path.join(WEB_ROOT, 'src/app/globals.css');
  const result = await postcss([tailwindcss({ base: WEB_ROOT })]).process(
    fs.readFileSync(globals, 'utf8'),
    {
      from: globals,
    },
  );
  css = result.css;
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>U15.1 harness</title>
<script>${THEME_PRE_PAINT_SCRIPT}</script><link rel="stylesheet" href="/harness.css"></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

async function open(page: Page, theme: 'light' | 'dark' | 'system' = 'light') {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/harness.js')
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/harness.css')
      return route.fulfill({ contentType: 'text/css', body: css });
    return route.fulfill({ contentType: 'text/html', body: PAGE });
  });
  if (theme !== 'system') {
    await page.context().addCookies([{ name: 'acc_theme_preference', value: theme, url: ORIGIN }]);
  }
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole('heading', { name: 'U15.1 design system harness' })).toBeVisible();
  return errors;
}

/** WCAG contrast of two computed CSS colours (rgb/rgba, opaque assumed after compositing). */
const CONTRAST_FN = `
  (() => {
    const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length >= 3 && (c.length < 4 || c[3] > 0.99)) return c;
      }
      return [255, 255, 255];
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    window.__contrast = (el, mode) => {
      const bg = bgOf(mode === 'border' ? el.parentElement : el);
      const fg = parse(mode === 'border' ? getComputedStyle(el).borderTopColor : getComputedStyle(el).color);
      return Math.round(ratio(fg, bg) * 100) / 100;
    };
  })();
`;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test(`renders without errors; the theme class matches the preference`, async ({ page }) => {
      const errors = await open(page, theme);
      await expect(page.locator('html')).toHaveClass(
        theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b).*$/,
      );
      expect(errors).toEqual([]);
    });

    test(`rendered contrast meets WCAG 2.2 AA (text 4.5:1, boundaries 3:1), including hover`, async ({
      page,
    }) => {
      await open(page, theme);
      await page.addScriptTag({ content: CONTRAST_FN });
      const text = page.locator('[data-contrast="text"]');
      const count = await text.count();
      expect(count).toBeGreaterThan(8);
      for (let i = 0; i < count; i += 1) {
        const el = text.nth(i);
        const label = (await el.textContent())?.trim();
        const ratio = await el.evaluate((n) =>
          (window as unknown as { __contrast: (e: Element) => number }).__contrast(n),
        );
        expect(ratio, `${theme} "${label}" text contrast`).toBeGreaterThanOrEqual(4.5);
        if ((await el.evaluate((n) => n.tagName)) === 'BUTTON') {
          await el.hover();
          await page.waitForTimeout(150);
          const hover = await el.evaluate((n) =>
            (window as unknown as { __contrast: (e: Element) => number }).__contrast(n),
          );
          expect(hover, `${theme} "${label}" hover contrast`).toBeGreaterThanOrEqual(4.5);
          await page.mouse.move(0, 0);
        }
      }
      for (const el of await page.locator('[data-contrast-border]').all()) {
        const ratio = await el.evaluate((n) =>
          (window as unknown as { __contrast: (e: Element, m: string) => number }).__contrast(
            n,
            'border',
          ),
        );
        expect(ratio, `${theme} control boundary contrast`).toBeGreaterThanOrEqual(3);
      }
    });

    test(`visible 2px primary focus indicator on keyboard focus`, async ({ page }) => {
      await open(page, theme);
      const primary = page.getByRole('button', { name: 'Primary' });
      await primary.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(primary).toBeFocused();
      const outline = await primary.evaluate((n) => {
        const s = getComputedStyle(n);
        return {
          width: s.outlineWidth,
          style: s.outlineStyle,
          offset: s.outlineOffset,
          color: s.outlineColor,
        };
      });
      expect(outline.width).toBe('2px');
      expect(outline.style).toBe('solid');
      expect(outline.offset).toBe('2px');
      const expected = await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--acc-primary)';
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(outline.color).toBe(expected);
    });

    test(`visual snapshot of every section`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'snapshots are recorded in Chromium');
      await open(page, theme);
      await page.mouse.move(0, 0);
      // The fixed bottom select exists only for the collision test; keep it out of section shots.
      await page
        .locator('[data-section="bottom-select"]')
        .evaluate((n) => ((n as HTMLElement).style.display = 'none'));
      for (const id of [
        'buttons',
        'inputs',
        'select',
        'badges',
        'cards',
        'navigation',
        'table',
        'empty',
      ]) {
        await expect(page.locator(`[data-section="${id}"]`)).toHaveScreenshot(`${id}-${theme}.png`);
      }
    });
  });
}

test('Select: APG keyboard model — open, move (skipping disabled), type-ahead, select, Escape, Tab', async ({
  page,
}) => {
  await open(page);
  const combo = page.getByRole('combobox', { name: 'Channel', exact: true });
  await combo.focus();
  await page.keyboard.press('ArrowDown');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  const listbox = page.getByRole('listbox', { name: 'Channel', exact: true });
  await expect(listbox).toBeVisible();
  const active = async () => {
    const id = await combo.getAttribute('aria-activedescendant');
    return id ? page.locator(`[id="${id}"]`).textContent() : null;
  };
  expect(await active()).toBe('SMS');
  await page.keyboard.press('ArrowDown'); // Email is disabled: skipped
  expect(await active()).toBe('RCS');
  await page.keyboard.press('End');
  expect(await active()).toBe('Viber');
  await page.keyboard.press('w'); // type-ahead
  expect(await active()).toBe('WhatsApp');
  await page.keyboard.press('Enter');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await expect(combo).toHaveText('WhatsApp');
  await expect(combo).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Escape'); // close without change
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await expect(combo).toHaveText('WhatsApp');

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Tab'); // selects the active option and moves on
  await expect(combo).toHaveText('RCS');
  await expect(combo).not.toBeFocused();

  // aria-selected follows the value
  await combo.click();
  await expect(page.getByRole('option', { name: 'RCS' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: 'Email' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('option', { name: 'Email' }).click({ force: true }); // disabled: no change
  await expect(combo).toHaveText('RCS');
});

test('Select: closed type-ahead changes the value; the menu flips above near the viewport bottom', async ({
  page,
}) => {
  await open(page);
  const combo = page.getByRole('combobox', { name: 'Channel', exact: true });
  await combo.focus();
  await page.keyboard.press('v');
  await expect(combo).toHaveText('Viber');
  const bottom = page.getByRole('combobox', { name: 'Bottom select' });
  await bottom.click();
  const list = page.getByRole('listbox', { name: 'Bottom select' });
  await expect(list).toHaveAttribute('data-placement', 'top');
  const [comboBox, listBox, viewport] = await Promise.all([
    bottom.boundingBox(),
    list.boundingBox(),
    page.viewportSize(),
  ]);
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(comboBox!.y);
  expect(listBox!.y).toBeGreaterThanOrEqual(0);
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(viewport!.width);
  await page.keyboard.press('Escape');
});

test('Tabs: arrows move and select (skipping disabled, wrapping), Home/End, panels follow', async ({
  page,
}) => {
  await open(page);
  const all = page.getByRole('tab', { name: 'All' });
  await all.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Failed' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Failed' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveText('Failed messages panel');
  await page.keyboard.press('ArrowRight'); // Archived disabled
  await expect(page.getByRole('tab', { name: 'Scheduled' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); // wraps
  await expect(all).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Scheduled' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Home');
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Failed' })).toHaveAttribute('tabindex', '-1');
});

test('Theme control: radio group with arrow keys; preference stored; system follows the OS live', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, 'system');
  const group = page.getByRole('radiogroup', { name: 'Theme' });
  await expect(group.getByRole('radio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await group.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  const cookies = Object.fromEntries(
    (await page.context().cookies(ORIGIN)).map((c) => [c.name, c.value]),
  );
  expect(cookies).toMatchObject({ acc_theme_preference: 'dark', acc_resolved_theme: 'dark' });
  await page.keyboard.press('ArrowLeft'); // Dark -> Light
  await expect(group.getByRole('radio', { name: 'Light' })).toBeFocused();
  await expect(group.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await page.emulateMedia({ colorScheme: 'dark' }); // explicit Light ignores the OS
  await page.waitForTimeout(200);
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await page.keyboard.press('ArrowLeft'); // Light -> System
  await expect(group.getByRole('radio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.locator('html')).toHaveClass(/\bdark\b/); // OS is dark
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
});

test('Inputs: error wiring, keyboard-operable password toggle', async ({ page }) => {
  await open(page);
  const email = page.getByLabel('Email');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toHaveAccessibleDescription('Enter a valid email address');
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await password.focus();
  await page.keyboard.press('Tab');
  const toggle = page.getByRole('button', { name: 'Show password' });
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(password).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('Drawer: modal focus management — focus inside, Tab contained, Escape closes, focus restored', async ({
  page,
}) => {
  await open(page);
  const trigger = page.getByRole('button', { name: 'Open inspector' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Inspector' });
  await expect(drawer).toBeVisible();
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('Tab');
    expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('DataTable: sorting and paging are emitted to the caller; rows are keyboard-activatable; no client re-ordering', async ({
  page,
}) => {
  await open(page);
  const table = page.getByRole('table', { name: 'Fixture messages' });
  const order = () => table.locator('tbody tr td:first-child').allTextContents();
  expect(await order()).toEqual(['Fixture row C', 'Fixture row A', 'Fixture row B']);
  const nameHeader = table.getByRole('columnheader', { name: 'Name' });
  await expect(nameHeader).toHaveAttribute('aria-sort', 'none');
  await nameHeader.getByRole('button').click();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('#events')).toContainText(
    'query:{"sortField":"name","sortDirection":"asc","page":1}',
  );
  expect(await order(), 'the table never sorts rows itself').toEqual([
    'Fixture row C',
    'Fixture row A',
    'Fixture row B',
  ]);
  await nameHeader.getByRole('button').click();
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#events')).toContainText('query:{"cursor":"cursor-2","page":2}');
  const row = page.getByRole('row', { name: 'Open Fixture row A' });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#events')).toContainText('row:r1');
});

test('Select inside a Drawer: Escape closes only the listbox; a second Escape closes the drawer', async ({
  page,
}) => {
  await open(page);
  await page.getByRole('button', { name: 'Open inspector' }).click();
  const drawer = page.getByRole('dialog', { name: 'Inspector' });
  const filter = drawer.getByRole('combobox', { name: 'Drawer filter' });
  await filter.focus();
  await page.keyboard.press('ArrowDown');
  await expect(filter).toHaveAttribute('aria-expanded', 'true');
  // The listbox renders inside the modal, so it stays in the accessibility tree.
  await expect(drawer.getByRole('listbox', { name: 'Drawer filter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(filter).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).toBeVisible();
  await expect(filter).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('DataTable: a button inside a clickable row keeps its own keyboard and mouse activation', async ({
  page,
}) => {
  await open(page);
  const revoke = page.getByRole('button', { name: 'Revoke Fixture row A' });
  await revoke.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#events')).toContainText('action:r1');
  await page.keyboard.press('Space');
  await revoke.click();
  const events = (await page.locator('#events').textContent()) ?? '';
  expect(events.split('|').filter((e) => e === 'action:r1')).toHaveLength(3);
  expect(events).not.toContain('row:r1');
});

test('Tabs: when the value matches no enabled tab, the first enabled tab is still reachable by keyboard', async ({
  page,
}) => {
  await open(page);
  const second = page.getByRole('tab', { name: 'Second' });
  await expect(second).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('tab', { name: 'First (disabled)' })).toHaveAttribute(
    'tabindex',
    '-1',
  );
});
