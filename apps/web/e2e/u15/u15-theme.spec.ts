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

async function instrumentAuthenticatedConsole(context: BrowserContext): Promise<Collected> {
  const collected: Collected = { console: [] };
  await context.route('http://api.u15.test/**', (route) => {
    const url = route.request().url();
    if (url.includes('/auth/refresh')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { accessToken: 'mock-valid-token' } }),
      });
    }
    if (url.includes('/auth/me/authorization')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            actorType: 'user',
            userId: '01955b0a-0000-7000-8000-000000000001',
            apiKeyId: null,
            organizationIds: ['01955b0a-0000-7000-8000-000000000002'],
            isPlatformAdmin: false,
            grants: [
              {
                roleId: '01955b0a-0000-7000-8000-000000000003',
                roleKey: 'org_admin',
                scopeType: 'organization',
                scopeId: '01955b0a-0000-7000-8000-000000000002',
                orgId: '01955b0a-0000-7000-8000-000000000002',
                permissions: ['messages.read'],
              },
            ],
          },
        }),
      });
    }
    if (url.includes('/auth/me')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            userId: '01955b0a-0000-7000-8000-000000000001',
            actorType: 'user',
            authMethod: 'session',
            sessionId: 'session-1',
            authenticatedAt: new Date().toISOString(),
            tenant: {
              orgId: '01955b0a-0000-7000-8000-000000000002',
              workspaceId: null,
              resellerId: null,
              isPlatformAdmin: false,
            },
            authorizedOrganizationIds: ['01955b0a-0000-7000-8000-000000000002'],
            roles: [],
            permissions: ['messages.read'],
          },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await context.addInitScript(() => {
    const w = window as unknown as {
      __csp: string[];
      __asideMutations: string[];
    };
    w.__csp = [];
    w.__asideMutations = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
    const start = () => {
      const target = document.documentElement;
      if (!target) return;
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'class') {
            const targetEl = m.target as HTMLElement;
            if (targetEl.tagName === 'ASIDE') {
              w.__asideMutations.push(targetEl.className);
            }
          }
        }
      });
      observer.observe(target, {
        attributes: true,
        subtree: true,
        attributeFilter: ['class'],
      });
    };
    if (document.documentElement) {
      start();
    } else {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    }
  });

  context.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      collected.console.push(`${m.type()}: ${m.text()}`);
    }
  });

  return collected;
}

test('Next.js SSR request path: cookie acc_sidebar_collapsed=1 returns HTML with w-16 and collapsed toggle', async ({
  request,
}) => {
  const res = await request.get('/', {
    headers: { cookie: 'acc_sidebar_collapsed=1' },
  });
  expect(res.status()).toBe(200);
  const raw = await res.text();
  expect(raw).toMatch(/<aside[^>]*aria-label="Sidebar"[^>]*class="[^"]*\bw-16\b[^"]*"/);
  expect(raw).not.toMatch(/<aside[^>]*aria-label="Sidebar"[^>]*class="[^"]*\bw-60\b[^"]*"/);
  expect(raw).toContain('aria-label="Expand sidebar"');
  expect(raw).toContain('aria-expanded="false"');
});

test('Next.js SSR request path: cookie acc_sidebar_collapsed=0 returns HTML with w-60 and expanded toggle', async ({
  request,
}) => {
  const res = await request.get('/', {
    headers: { cookie: 'acc_sidebar_collapsed=0' },
  });
  expect(res.status()).toBe(200);
  const raw = await res.text();
  expect(raw).toMatch(/<aside[^>]*aria-label="Sidebar"[^>]*class="[^"]*\bw-60\b[^"]*"/);
  expect(raw).not.toMatch(/<aside[^>]*aria-label="Sidebar"[^>]*class="[^"]*\bw-16\b[^"]*"/);
  expect(raw).toContain('aria-label="Collapse sidebar"');
  expect(raw).toContain('aria-expanded="true"');
});

test('Next.js Real Application: browser first-render with acc_sidebar_collapsed=1 renders w-16 without hydration mismatch or width transition', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  const collected = await instrumentAuthenticatedConsole(context);
  await context.addCookies([{ name: 'acc_sidebar_collapsed', value: '1', url: baseURL! }]);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/', { waitUntil: 'load' });

  const sidebar = page.locator('aside[aria-label="Sidebar"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveClass(/\bw-16\b/);
  await expect(sidebar).not.toHaveClass(/\bw-60\b/);

  const toggleBtn = sidebar.getByRole('button', { name: 'Expand sidebar' });
  await expect(toggleBtn).toBeVisible();
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

  await page.waitForLoadState('networkidle');

  const mutations = await page.evaluate(() => {
    const w = window as unknown as { __asideMutations: string[]; __csp: string[] };
    return { asideMutations: w.__asideMutations, csp: w.__csp };
  });

  // Verify no mutation altered sidebar from w-60 to w-16 after load
  expect(mutations.asideMutations.filter((c) => c.includes('w-60'))).toEqual([]);
  assertClean(collected, mutations.csp);
  await context.close();
});

test('Next.js Real Application: browser first-render with acc_sidebar_collapsed=0 renders w-60 without hydration mismatch or width transition', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext();
  const collected = await instrumentAuthenticatedConsole(context);
  await context.addCookies([{ name: 'acc_sidebar_collapsed', value: '0', url: baseURL! }]);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/', { waitUntil: 'load' });

  const sidebar = page.locator('aside[aria-label="Sidebar"]');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveClass(/\bw-60\b/);
  await expect(sidebar).not.toHaveClass(/\bw-16\b/);

  const toggleBtn = sidebar.getByRole('button', { name: 'Collapse sidebar' });
  await expect(toggleBtn).toBeVisible();
  await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

  await page.waitForLoadState('networkidle');

  const mutations = await page.evaluate(() => {
    const w = window as unknown as { __asideMutations: string[]; __csp: string[] };
    return { asideMutations: w.__asideMutations, csp: w.__csp };
  });

  // Verify no mutation altered sidebar from w-16 to w-60 after load
  expect(mutations.asideMutations.filter((c) => c.includes('w-16'))).toEqual([]);
  assertClean(collected, mutations.csp);
  await context.close();
});
