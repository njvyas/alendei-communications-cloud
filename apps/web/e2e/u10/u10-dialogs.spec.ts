import path from 'node:path';
import { build } from 'esbuild';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * U10 real-browser validation of the console dialog focus management
 * (`useModalDialog` / `AccessibleDialog`, including the H-1 global keydown
 * listener and the H-2 focusable panels).
 *
 * The harness (`harness.tsx`) renders production dialog components; it is
 * bundled here with esbuild and served via request routing. API calls go to a
 * routed fake origin, so no backend, database or credentials are involved.
 */

const APP_ORIGIN = 'http://u10.test';
const API_BASE = 'http://api.u10.test/api/v1';
const WEB_ROOT = path.resolve(__dirname, '../..');

let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [path.join(__dirname, 'harness.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    jsx: 'automatic',
    tsconfig: path.join(WEB_ROOT, 'tsconfig.json'),
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.NEXT_PUBLIC_API_BASE_URL': JSON.stringify(API_BASE),
    },
    banner: { js: 'var process = { env: {} };' },
    logLevel: 'silent',
  });
  bundle = result.outputFiles[0]!.text;
});

/** Instrumentation installed before the app: window-level key log and document keydown listener count. */
const INSTRUMENTATION = `
  window.__windowKeys = [];
  window.addEventListener('keydown', (e) => window.__windowKeys.push(e.key));
  (() => {
    const active = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
      if (type === 'keydown') active.add(listener);
      return add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      if (type === 'keydown') active.delete(listener);
      return remove(type, listener, options);
    };
    window.__docKeydownListeners = () => active.size;
  })();
`;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>U10 harness</title>
<style>
  body { font-family: sans-serif; margin: 16px; }
  .fixed { position: fixed; } .inset-0 { inset: 0; } .flex { display: flex; }
  .items-center { align-items: center; } .justify-center { justify-content: center; }
  .z-50 { z-index: 50; } .p-4 { padding: 16px; } .p-6 { padding: 24px; }
  [role="dialog"] { background: rgba(0,0,0,0.5); }
  [role="dialog"] > div { background: #fff; width: 100%; max-width: 480px; }
</style>
<script>${INSTRUMENTATION}</script></head>
<body><div id="root"></div><script src="/harness.js"></script></body></html>`;

interface ApiControl {
  releaseSave: () => void;
  saveRequests: number;
}

async function openHarness(page: Page): Promise<ApiControl> {
  let releaseSave: () => void = () => {};
  const saveGate = new Promise<void>((resolve) => (releaseSave = resolve));
  const control: ApiControl = { releaseSave: () => releaseSave(), saveRequests: 0 };

  await page.route(`${APP_ORIGIN}/**`, (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/harness.js') {
      return route.fulfill({ contentType: 'text/javascript', body: bundle });
    }
    return route.fulfill({ contentType: 'text/html', body: HTML });
  });

  await page.route('http://api.u10.test/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const cors = {
      'access-control-allow-origin': APP_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'Accept, Content-Type, Authorization, X-Acc-Organization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: cors });
    }
    if (url.pathname.endsWith('/channels')) {
      return route.fulfill({
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: '01955b0a-7b3b-7411-9a4f-0000000000c1',
              code: 'sms',
              displayName: 'SMS',
              status: 'active',
              createdAt: '2026-10-31T00:00:00.000Z',
              updatedAt: '2026-10-31T00:00:00.000Z',
            },
            {
              id: '01955b0a-7b3b-7411-9a4f-0000000000c2',
              code: 'whatsapp',
              displayName: 'WhatsApp',
              status: 'active',
              createdAt: '2026-10-31T00:00:00.000Z',
              updatedAt: '2026-10-31T00:00:00.000Z',
            },
          ],
          page: { hasMore: false, nextCursor: null },
        }),
      });
    }
    if (url.pathname.endsWith('/disable')) {
      control.saveRequests++;
      await saveGate; // hold the save "in progress" until the test releases it
      return route.fulfill({
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ data: {} }),
      });
    }
    return route.fulfill({
      status: 404,
      headers: cors,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await page.goto(`${APP_ORIGIN}/`);
  await expect(page.getByRole('heading', { name: 'U10 dialog harness' })).toBeVisible();
  return control;
}

/** Describes the focused element: its dialog (by title id), tag and accessible text. */
async function focused(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const dialog = el?.closest('[role="dialog"]');
    return {
      dialog: dialog?.getAttribute('aria-labelledby') ?? null,
      tag: el?.tagName.toLowerCase() ?? null,
      text: (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim(),
      id: el?.id ?? '',
      isPanel:
        !!el &&
        el.getAttribute('tabindex') === '-1' &&
        el.parentElement?.getAttribute('role') === 'dialog',
    };
  });
}

const windowKeys = (page: Page) =>
  page.evaluate(() => (window as unknown as { __windowKeys: string[] }).__windowKeys.slice());
const clearWindowKeys = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __windowKeys: string[] }).__windowKeys.length = 0;
  });
const docKeydownListeners = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __docKeydownListeners: () => number }).__docKeydownListeners(),
  );

const TRANSITION = 'provider-transition-title';

test.describe('U10 dialogs in a real browser', () => {
  test('1–2: initial focus enters the dialog; Tab and Shift+Tab stay inside', async ({ page }) => {
    await openHarness(page);
    await page.getByRole('button', { name: 'Open transition dialog' }).click();
    const dialog = page.getByRole('dialog', { name: 'Disable Provider' });
    await expect(dialog).toBeVisible();

    expect(await focused(page)).toMatchObject({ dialog: TRANSITION, text: 'Cancel' });

    const forward: string[] = [];
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab');
      const f = await focused(page);
      expect(f.dialog).toBe(TRANSITION);
      forward.push(f.text);
    }
    expect(forward).toEqual([
      'Disable Provider',
      'Cancel',
      'Disable Provider',
      'Cancel',
      'Disable Provider',
    ]);

    const backward: string[] = [];
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab');
      const f = await focused(page);
      expect(f.dialog).toBe(TRANSITION);
      backward.push(f.text);
    }
    expect(backward).toEqual(['Cancel', 'Disable Provider', 'Cancel', 'Disable Provider']);
  });

  test('3: focus moved outside the dialog is pulled back in by Tab / Shift+Tab', async ({
    page,
  }) => {
    await openHarness(page);
    await page.getByRole('button', { name: 'Open transition dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Disable Provider' })).toBeVisible();

    await page.evaluate(() => document.getElementById('outside')?.focus());
    expect(await focused(page)).toMatchObject({ dialog: null, id: 'outside' });
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ dialog: TRANSITION, text: 'Cancel' });

    await page.evaluate(() => document.getElementById('outside')?.focus());
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toMatchObject({ dialog: TRANSITION, text: 'Disable Provider' });

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect((await focused(page)).tag).toBe('body');
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ dialog: TRANSITION, text: 'Cancel' });
  });

  test('4–5: Escape dismisses (also with focus outside) and focus returns to the trigger', async ({
    page,
  }) => {
    await openHarness(page);
    const trigger = page.getByRole('button', { name: 'Open transition dialog' });

    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Escape while focus has escaped the dialog subtree (H-1).
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => document.getElementById('outside')?.focus());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Same for the AccessibleDialog primitive.
    const parentTrigger = page.getByRole('button', { name: 'Open parent dialog' });
    await parentTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Parent dialog' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(parentTrigger).toBeFocused();
  });

  test('6: Escape is ignored while a save is in progress', async ({ page }) => {
    const api = await openHarness(page);
    const trigger = page.getByRole('button', { name: 'Open transition dialog' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Disable Provider' });
    await dialog.getByRole('button', { name: 'Disable Provider' }).click();
    await expect(dialog.getByRole('button', { name: 'Updating…' })).toBeDisabled();
    expect(api.saveRequests).toBe(1);

    await clearWindowKeys(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    expect(await windowKeys(page)).toEqual([]); // consumed by the dialog, not passed to the page

    // With every control disabled, Tab keeps focus on the dialog panel.
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ dialog: TRANSITION, isPanel: true });

    api.releaseSave();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('7–8: only the topmost nested dialog handles keys; the parent resumes after it closes', async ({
    page,
  }) => {
    await openHarness(page);
    const base = await docKeydownListeners(page);
    await page.getByRole('button', { name: 'Open parent dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Parent dialog' })).toBeVisible();
    expect(await focused(page)).toMatchObject({ dialog: 'parent-title', id: 'parent-input' });

    const openChild = page.getByRole('button', { name: 'Open child dialog' });
    await openChild.click();
    await expect(page.getByRole('dialog', { name: 'Child dialog' })).toBeVisible();
    expect(await docKeydownListeners(page)).toBe(base + 2);
    expect(await focused(page)).toMatchObject({ dialog: 'child-title', text: 'Child first' });

    const seen: string[] = [];
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      const f = await focused(page);
      expect(f.dialog).toBe('child-title');
      seen.push(f.text);
    }
    expect(seen).toEqual(['Child last', 'Child first', 'Child last', 'Child first', 'Child last']);

    // Focus forced into the parent while the child is open: Tab returns to the child.
    await page.evaluate(() => document.getElementById('parent-input')?.focus());
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ dialog: 'child-title', text: 'Child first' });

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Child dialog' })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Parent dialog' })).toBeVisible();
    await expect(openChild).toBeFocused();
    expect(await docKeydownListeners(page)).toBe(base + 1);

    const parentSeen: string[] = [];
    for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      const f = await focused(page);
      expect(f.dialog).toBe('parent-title');
      parentSeen.push(f.id || f.text);
    }
    expect(parentSeen).toEqual([
      'Close parent',
      'parent-input',
      'Open child dialog',
      'parent-input',
    ]);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open parent dialog' })).toBeFocused();
    expect(await docKeydownListeners(page)).toBe(base);
  });

  test('9: a dialog whose controls are all disabled focuses its panel', async ({ page }) => {
    await openHarness(page);
    const trigger = page.getByRole('button', { name: 'Open disabled dialog' });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'All controls disabled' })).toBeVisible();
    expect(await focused(page)).toMatchObject({ dialog: 'disabled-title', isPanel: true });
    await page.keyboard.press('Tab');
    expect(await focused(page)).toMatchObject({ dialog: 'disabled-title', isPanel: true });
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).toMatchObject({ dialog: 'disabled-title', isPanel: true });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('10: keyboard listeners are removed after close and after unmount', async ({ page }) => {
    await openHarness(page);
    const base = await docKeydownListeners(page);
    const trigger = page.getByRole('button', { name: 'Open transition dialog' });

    // Close path.
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await docKeydownListeners(page)).toBe(base + 1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await docKeydownListeners(page)).toBe(base);

    await clearWindowKeys(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    expect(await windowKeys(page)).toEqual(['Escape', 'Tab']); // no longer intercepted
    expect(await focused(page)).toMatchObject({ dialog: null, text: 'Open create dialog' });

    // Unmount path: remove the component while its dialog is open.
    const unmountTrigger = page.getByRole('button', { name: 'Open unmount dialog' });
    await unmountTrigger.click();
    await expect(page.getByRole('dialog', { name: 'Unmount dialog' })).toBeVisible();
    expect(await docKeydownListeners(page)).toBe(base + 1);
    await page.evaluate(() => (window as unknown as { __u10Unmount: () => void }).__u10Unmount());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await docKeydownListeners(page)).toBe(base);
    await expect(unmountTrigger).toBeFocused();

    await clearWindowKeys(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Tab');
    // Shift+Tab also emits a keydown for Shift itself.
    expect(await windowKeys(page)).toEqual(['Escape', 'Shift', 'Tab']);
    expect((await focused(page)).dialog).toBeNull();
  });

  test('11: native select inside a dialog — keyboard selection and Escape', async ({ page }) => {
    await openHarness(page);
    await page.getByRole('button', { name: 'Open create dialog' }).click();
    const dialog = page.getByRole('dialog', { name: 'Create Provider' });
    await expect(dialog).toBeVisible();
    const select = dialog.getByLabel(/Channel/);
    await expect(select).toBeEnabled();

    await select.focus();
    const before = await select.inputValue();
    await page.keyboard.press('ArrowDown');
    // Arrow keys on a closed native select change its value and keep focus there.
    await expect(select).toBeFocused();
    await expect(dialog).toBeVisible();
    const after = await select.inputValue();
    test.info().annotations.push({
      type: 'select-arrow',
      description: `value ${before || '(empty)'} -> ${after || '(empty)'}`,
    });

    // Escape with the select focused (popup closed) dismisses the dialog.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('11b: Escape on an expanded native select does not close the dialog; Escape on the collapsed select does', async ({
    page,
  }, testInfo) => {
    await openHarness(page);
    const trigger = page.getByRole('button', { name: 'Open create dialog' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Create Provider' });
    const select = dialog.getByLabel(/Channel/);
    await expect(select).toBeEnabled();
    await page.fill('#create-provider-name', 'Typed before Escape');

    const isOpen = () => select.evaluate((el) => el.matches(':open'));
    await select.focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(isOpen, { message: 'picker should report :open' }).toBe(true);

    // Regression for the Firefox 155 defect: this Escape must not close the dialog.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#create-provider-name')).toHaveValue('Typed before Escape');
    await expect(select).toBeFocused();

    if (testInfo.project.name === 'firefox') {
      // Playwright injects Firefox key events into the page, bypassing the native
      // picker, so the picker is not collapsed by that Escape (verified: it stays
      // :open). Collapse it by moving focus away, then return to the select.
      testInfo.annotations.push({
        type: 'limitation',
        description:
          'Firefox: picker collapse on Escape cannot be driven by Playwright; collapsed via blur',
      });
      await select.evaluate((el) => (el as HTMLElement).blur());
      await expect.poll(isOpen).toBe(false);
      await select.focus();
    } else {
      await expect.poll(isOpen, { message: 'first Escape collapses the picker' }).toBe(false);
    }

    // Escape on the collapsed select closes the dialog and restores focus.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('12: backdrop click — AccessibleDialog closes, custom dialogs do not', async ({ page }) => {
    await openHarness(page);

    await page.getByRole('button', { name: 'Open parent dialog' }).click();
    const parent = page.getByRole('dialog', { name: 'Parent dialog' });
    await expect(parent).toBeVisible();
    await parent.click({ position: { x: 4, y: 4 } });
    await expect(parent).toHaveCount(0);

    await page.getByRole('button', { name: 'Open transition dialog' }).click();
    const custom = page.getByRole('dialog', { name: 'Disable Provider' });
    await expect(custom).toBeVisible();
    await custom.click({ position: { x: 4, y: 4 } });
    await expect(custom).toBeVisible();
    // The backdrop is focusable (tabIndex -1), so keyboard handling still applies after the click.
    expect((await focused(page)).dialog).toBe(TRANSITION);
    await page.keyboard.press('Escape');
    await expect(custom).toHaveCount(0);
  });
});
