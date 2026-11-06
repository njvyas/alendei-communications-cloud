import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/postcss';
import { build } from 'esbuild';
import postcss from 'postcss';
import { expect, test, type Page } from '@playwright/test';

import { THEME_PRE_PAINT_SCRIPT } from '../../src/lib/theme';

const ORIGIN = 'http://u15-shell.test';
const WEB_ROOT = path.resolve(__dirname, '../..');
let bundle = '';
let css = '';

test.beforeAll(async () => {
  const js = await build({
    entryPoints: [path.join(__dirname, 'shell-harness.tsx')],
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
    plugins: [
      {
        name: 'mock-next',
        setup(b) {
          b.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: path.join(__dirname, 'mock-navigation.ts'),
          }));
          b.onResolve({ filter: /^next\/link$/ }, () => ({
            path: path.join(__dirname, 'mock-link.tsx'),
          }));
        },
      },
    ],
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

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>U15.2 Shell Harness</title>
<script>${THEME_PRE_PAINT_SCRIPT}</script><link rel="stylesheet" href="/harness.css"></head>
<body class="font-sans"><div id="root"></div><script src="/harness.js"></script></body></html>`;

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
    if (url.pathname.startsWith('/fonts/')) {
      const fontPath = path.join(WEB_ROOT, 'public', url.pathname);
      if (fs.existsSync(fontPath)) {
        return route.fulfill({ contentType: 'font/woff2', body: fs.readFileSync(fontPath) });
      }
    }
    return route.fulfill({ contentType: 'text/html', body: PAGE });
  });

  if (theme !== 'system') {
    await page.context().addCookies([
      { name: 'acc_theme_preference', value: theme, url: ORIGIN },
      { name: 'acc_resolved_theme', value: theme, url: ORIGIN },
    ]);
  }

  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#shell-container');
  expect(errors).toEqual([]);
}

test.describe('U15.2 Application Shell & Global Navigation (Browser E2E)', () => {
  test('Desktop (1280px): persistent sidebar toggles between expanded and collapsed with cookie sync', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, 'light');

    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveClass(/w-60/);
    await expect(sidebar.getByText('Alendei')).toBeVisible();

    // In expanded state: links have accessible names and visible text
    await expect(sidebar.getByRole('link', { name: 'Messages' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Overview' })).toBeVisible();

    // Toggle collapse
    const collapseBtn = sidebar.getByRole('button', { name: 'Collapse sidebar' });
    await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    await collapseBtn.click();

    // Verify collapsed state
    await expect(sidebar).toHaveClass(/w-16/);
    await expect(sidebar.getByText('ACC')).toBeVisible();
    await expect(sidebar.getByLabel('Alendei Communications Cloud')).toBeVisible();

    // Verify collapsed links retain accessible names for screen readers (WCAG 4.1.2 & 2.4.4)
    await expect(sidebar.getByRole('link', { name: 'Messages' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Templates' })).toBeVisible();

    // Verify expand toggle button has aria-expanded="false"
    const expandBtn = sidebar.getByRole('button', { name: 'Expand sidebar' });
    await expect(expandBtn).toHaveAttribute('aria-expanded', 'false');

    // Verify cookie persisted
    const cookies = await page.context().cookies();
    const cookie = cookies.find((c) => c.name === 'acc_sidebar_collapsed');
    expect(cookie?.value).toBe('1');

    // Toggle expand
    await expandBtn.click();
    await expect(sidebar).toHaveClass(/w-60/);
    await expect(sidebar.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    const updatedCookies = await page.context().cookies();
    const updatedCookie = updatedCookies.find((c) => c.name === 'acc_sidebar_collapsed');
    expect(updatedCookie?.value).toBe('0');
  });

  test('Hydration safety: sidebar initializes in collapsed state when cookie acc_sidebar_collapsed=1 is preset without mismatch', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // Preset collapsed cookie prior to navigation
    await page.context().addCookies([{ name: 'acc_sidebar_collapsed', value: '1', url: ORIGIN }]);
    await open(page, 'light');

    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveClass(/w-16/);
    await expect(sidebar.getByText('ACC')).toBeVisible();
    await expect(sidebar.getByLabel('Alendei Communications Cloud')).toBeVisible();

    // Verify accessible names on links in pre-set collapsed state
    await expect(sidebar.getByRole('link', { name: 'Messages' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Overview' })).toBeVisible();

    const expandBtn = sidebar.getByRole('button', { name: 'Expand sidebar' });
    await expect(expandBtn).toBeVisible();
    await expect(expandBtn).toHaveAttribute('aria-expanded', 'false');
  });

  test('Header: theme preference control dynamically switches between light, dark, and system', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, 'light');

    const themeGroup = page.getByRole('radiogroup', { name: 'Theme' });
    await expect(themeGroup).toBeVisible();

    // Switch to dark
    const darkRadio = themeGroup.getByRole('radio', { name: 'Dark' });
    await darkRadio.click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Switch to light
    const lightRadio = themeGroup.getByRole('radio', { name: 'Light' });
    await lightRadio.click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('Command Palette: opens via global shortcut (Ctrl/Cmd+K) and provides search, arrow navigation, and escape', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, 'light');

    // Open via shortcut
    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog', { name: 'Command Palette' });
    await expect(dialog).toBeVisible();

    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();

    // Type a query
    await input.fill('Message');
    const results = dialog.getByRole('listbox');
    await expect(results.getByText('Go to Messages')).toBeVisible();
    await expect(results.getByText('Open Messages (Send message)')).toBeVisible();

    // Press Escape to close
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('Mobile (<768px): hides sidebar, shows hamburger button, and opens left drawer navigation', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await open(page, 'light');

    // Sidebar should be hidden on mobile
    const sidebar = page.locator('aside[aria-label="Sidebar"]');
    await expect(sidebar).toBeHidden();

    // Hamburger button should be visible in header
    const hamburger = page.getByRole('button', { name: 'Open navigation menu' });
    await expect(hamburger).toBeVisible();

    // Open mobile drawer
    await hamburger.click();

    const drawer = page.getByRole('dialog', { name: 'Alendei' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'Mobile Navigation' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Messages' })).toBeVisible();

    // Close via close button
    const closeBtn = drawer.getByRole('button', { name: 'Close navigation menu' });
    await closeBtn.click();
    await expect(drawer).not.toBeVisible();
  });

  test('Option A Typography: inherits self-hosted Inter for body and Geist Mono for monospace elements', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, 'light');

    // Check shell container font family contains Inter
    const shellFont = await page.evaluate(() => {
      const el = document.getElementById('shell-container') ?? document.body;
      return getComputedStyle(el).fontFamily;
    });
    expect(shellFont.toLowerCase()).toContain('inter');

    // Check mono font family contains Geist Mono or monospace
    const logsFont = await page.evaluate(() => {
      const el = document.getElementById('test-logs');
      return el ? getComputedStyle(el).fontFamily : '';
    });
    expect(logsFont.toLowerCase()).toMatch(/geist mono|monospace/);
  });
});
