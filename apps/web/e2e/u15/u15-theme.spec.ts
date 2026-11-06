import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * U15.1 theme, hydration and CSP checks against the real Next.js app (root layout,
 * proxy, pre-paint script) — specification §3.5 fresh-session protocol. Each test
 * uses a fresh browser context (no cookies, no storage), like a private window.
 * API calls are answered locally so no backend is needed.
 */

const PATH = '/login';
// Development wording and the production (minified) React hydration error codes.
const HYDRATION =
  /hydrat|did not match|didn't match|server rendered html|Minified React error #(418|423|425)/i;

interface Collected {
  readonly console: string[];
}

async function instrument(context: BrowserContext): Promise<Collected> {
  const collected: Collected = { console: [] };
  await context.route('http://api.u15.test/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"error":{"code":"RESOURCE_NOT_FOUND"}}',
    }),
  );
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[]; __dcl?: { cls: string; bg: string } };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    document.addEventListener('DOMContentLoaded', () => {
      // The theme tokens actually in effect (the login page body has its own background).
      w.__dcl = {
        cls: document.documentElement.className,
        bg: getComputedStyle(document.documentElement).getPropertyValue('--acc-bg').trim(),
      };
    });
  });
  // React reports hydration mismatches with console.error; other entry types (for example
  // Firefox's `timeStamp: Hydrated` performance marks in development) are not warnings.
  context.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      collected.console.push(`${m.type()}: ${m.text()}`);
    }
  });
  return collected;
}

/** `--acc-bg` per theme (globals.css). */
const CANVAS = { dark: '#0d1222', light: '#f7f8fc' } as const;

async function state(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __csp: string[]; __dcl?: { cls: string; bg: string } };
    return { csp: w.__csp, dcl: w.__dcl, cls: document.documentElement.className };
  });
}

function assertClean(collected: Collected, csp: string[]) {
  expect(
    collected.console.filter((m) => HYDRATION.test(m)),
    'hydration warnings',
  ).toEqual([]);
  expect(
    collected.console.filter((m) => /content security policy|Refused to/i.test(m)),
    'CSP console errors',
  ).toEqual([]);
  expect(csp, 'securitypolicyviolation events').toEqual([]);
}

for (const os of ['dark', 'light'] as const) {
  test(`cold first visit, OS ${os}: correct theme before first paint, no hydration warnings, no CSP violations`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: os });
    const collected = await instrument(context);
    const page = await context.newPage();
    const response = await page.goto(PATH);
    // The server cannot know the OS theme on a cold visit: it renders without the class…
    const raw = await response!.text();
    expect(raw).toMatch(/<html lang="en"[^>]*>/);
    expect(raw).not.toMatch(/<html[^>]*class="dark"/);
    // …and the pre-paint script has applied the OS theme by DOMContentLoaded (before hydration).
    const s = await state(page);
    expect(s.dcl?.cls.includes('dark')).toBe(os === 'dark');
    expect(s.dcl?.bg).toBe(CANVAS[os]);
    await page.waitForLoadState('networkidle');
    expect((await state(page)).cls.includes('dark')).toBe(os === 'dark');
    const cookies = Object.fromEntries((await context.cookies()).map((c) => [c.name, c.value]));
    expect(cookies.acc_resolved_theme).toBe(os);
    assertClean(collected, (await state(page)).csp);
    await context.close();
  });

  test(`cold first visit, OS ${os}, application JavaScript blocked: the painted page already has the right theme`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: os });
    await instrument(context);
    await context.route('**/_next/static/**/*.js', (route) => route.abort());
    const page = await context.newPage();
    await page.goto(PATH, { waitUntil: 'load' });
    // Only the inline pre-paint script ran — no React, no hydration.
    const s = await state(page);
    expect(s.cls.includes('dark')).toBe(os === 'dark');
    expect(s.dcl?.bg).toBe(CANVAS[os]);
    const scheme = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(scheme).toBe(os);
    await context.close();
  });
}

test('explicit preference overrides the OS; the server renders the class in the raw HTML (hard refresh)', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ colorScheme: 'dark' });
  const collected = await instrument(context);
  await context.addCookies([{ name: 'acc_theme_preference', value: 'light', url: baseURL! }]);
  const page = await context.newPage();
  const response = await page.goto(PATH);
  expect(await response!.text()).toMatch(/<html lang="en">/);
  expect((await state(page)).dcl?.cls.includes('dark')).toBe(false);

  await context.addCookies([{ name: 'acc_theme_preference', value: 'dark', url: baseURL! }]);
  await page.emulateMedia({ colorScheme: 'light' });
  const second = await page.reload();
  expect(await second!.text()).toMatch(/<html lang="en" class="dark">/);
  expect((await state(page)).cls.includes('dark')).toBe(true);
  assertClean(collected, (await state(page)).csp);
  await context.close();
});

test('system preference: a warm visit is rendered by the server from the cached resolved theme', async ({
  request,
}) => {
  const res = await request.get(PATH, {
    headers: { cookie: 'acc_theme_preference=system; acc_resolved_theme=dark' },
  });
  expect(await res.text()).toMatch(/<html lang="en" class="dark">/);
});

test('system preference follows an OS change live, without reload, and updates the cached theme', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const collected = await instrument(context);
  const page = await context.newPage();
  await page.goto(PATH);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  const navigations: string[] = [];
  page.on('framenavigated', (f) => f === page.mainFrame() && navigations.push(f.url()));
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  const cookies = Object.fromEntries(
    (await context.cookies(baseURL!)).map((c) => [c.name, c.value]),
  );
  expect(cookies.acc_resolved_theme).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  expect(navigations, 'no reload').toEqual([]);
  assertClean(collected, (await state(page)).csp);
  await context.close();
});

test('CSP: per-request nonce on every script, no unsafe-inline for scripts, framing denied', async ({
  request,
}) => {
  const [a, b] = [await request.get(PATH), await request.get(PATH)];
  const policy = a.headers()['content-security-policy'];
  expect(policy).toBeTruthy();
  const scriptSrc = policy!.split('; ').find((d) => d.startsWith('script-src '))!;
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  const nonce = scriptSrc.match(/'nonce-([^']+)'/)![1]!;
  expect(b.headers()['content-security-policy']).not.toContain(nonce);
  const html = await a.text();
  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const tag of scripts)
    expect(tag, 'every script carries the request nonce').toContain(`nonce="${nonce}"`);
  expect(html).toContain('acc_theme_preference');
});
