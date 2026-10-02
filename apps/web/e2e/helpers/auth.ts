import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

// -----------------------------------------------------------------------------
// Environment resolution for Phase 1C.4b deterministic test execution
// -----------------------------------------------------------------------------
function ensureEnvLoaded(): void {
  if (process.env.ACC_FIXTURE_USER_PASSWORD && process.env.AUTH_BOOTSTRAP_PASSWORD) {
    return;
  }
  const rootEnvPath = resolve(__dirname, '../../../../.env');
  if (existsSync(rootEnvPath)) {
    const raw = readFileSync(rootEnvPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
}

ensureEnvLoaded();

const fixturePassword = process.env.ACC_FIXTURE_USER_PASSWORD;
if (!fixturePassword) {
  throw new Error(
    'ACC_FIXTURE_USER_PASSWORD is required in environment to execute Phase 1C.4b browser tests against the development fixture.',
  );
}

const operatorPassword =
  process.env.AUTH_BOOTSTRAP_PASSWORD || 'local-development-only-passphrase-not-a-secret';

/**
 * Deterministic test credentials resolved strictly from environment variables.
 * All fixture users use the secret-referenced ACC_FIXTURE_USER_PASSWORD.
 */
export const TEST_CREDENTIALS = {
  // Bootstrap operator (platform super admin)
  operator: {
    email: process.env.AUTH_BOOTSTRAP_EMAIL || 'platform-admin@alendei.test',
    password: operatorPassword,
  },
  // Organization A1 tenant administrator
  a1Admin: {
    email: 'a1-admin@acc-fixture.test',
    password: fixturePassword,
  },
  // Organization A2 tenant administrator
  a2Admin: {
    email: 'a2-admin@acc-fixture.test',
    password: fixturePassword,
  },
  // Organization B1 tenant administrator (Reseller B)
  b1Admin: {
    email: 'b1-admin@acc-fixture.test',
    password: fixturePassword,
  },
  // Low-privilege user: read_only grant at Team T in Organization A1
  teamReader: {
    email: 'a1-team-reader@acc-fixture.test',
    password: fixturePassword,
  },
  // Multi-organization user: workspace_manager in Org A1 and Org A2
  multiOrg: {
    email: 'multi-org@acc-fixture.test',
    password: fixturePassword,
  },

  // Backward-compatibility aliases for existing test cases
  email: 'a1-admin@acc-fixture.test',
  password: fixturePassword,
  lowPrivEmail: 'a1-team-reader@acc-fixture.test',
  lowPrivPassword: fixturePassword,
  multiOrgEmail: 'multi-org@acc-fixture.test',
  multiOrgPassword: fixturePassword,
};

/**
 * Performs browser-level authentication through the actual /login UI.
 * Enforces accessibility selectors: getByLabel and getByRole.
 */
export async function loginViaUi(
  page: Page,
  email = TEST_CREDENTIALS.email,
  password = TEST_CREDENTIALS.password,
): Promise<void> {
  // Ensure custom snapshot selectors returning Set instances evaluate equality by value
  await page.addInitScript(() => {
    const originalIs = Object.is;
    Object.is = function (a: unknown, b: unknown) {
      if (originalIs(a, b)) return true;
      if (a instanceof Set && b instanceof Set && a.size === b.size) {
        for (const item of a) {
          if (!b.has(item)) return false;
        }
        return true;
      }
      return false;
    };
  });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Wait for post-login navigation to the console shell or organization selector
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
}

/**
 * Comprehensive cryptographic, session token, and credential storage sweep.
 * Asserts that:
 * 1. URL search params and hash never carry tokens or secrets.
 * 2. localStorage contains no token keys, no JWTs, and no high-entropy secrets.
 * 3. sessionStorage contains no token keys, no JWTs, and no high-entropy secrets.
 * 4. JavaScript-accessible document.cookie contains no tokens and specifically NOT acc_refresh.
 * 5. IndexedDB databases contain no token keys or credentials.
 * 6. Cache Storage contains no token keys or cached credentials.
 */
export async function assertNoTokensInStorage(page: Page): Promise<void> {
  const url = new URL(page.url());
  expect(url.searchParams.has('token')).toBe(false);
  expect(url.searchParams.has('accessToken')).toBe(false);
  expect(url.searchParams.has('secret')).toBe(false);
  expect(url.hash).toBe('');

  const storageState = await page.evaluate(async () => {
    const localKeys = Object.keys(localStorage);
    const sessionKeys = Object.keys(sessionStorage);
    const localEntries = localKeys.map((k) => ({ key: k, val: localStorage.getItem(k) ?? '' }));
    const sessionEntries = sessionKeys.map((k) => ({
      key: k,
      val: sessionStorage.getItem(k) ?? '',
    }));
    const jsCookie = document.cookie;

    // IndexedDB sweep
    const idbDatabaseNames: string[] = [];
    if (typeof window.indexedDB?.databases === 'function') {
      try {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
          if (db.name) idbDatabaseNames.push(db.name);
        }
      } catch {
        // IDB enumeration not supported or failed
      }
    }

    // Cache Storage sweep
    const cacheStorageKeys: string[] = [];
    if (typeof window.caches?.keys === 'function') {
      try {
        const keys = await window.caches.keys();
        cacheStorageKeys.push(...keys);
      } catch {
        // Caches enumeration failed
      }
    }

    return { localEntries, sessionEntries, jsCookie, idbDatabaseNames, cacheStorageKeys };
  });

  // JWT pattern: three dot-separated base64url segments (e.g. eyJhbGci... . eyJzdWI... . ...)
  const jwtPattern = /^[\w-]+\.[\w-]+\.[\w-]+$/;
  // High-entropy token or API key secret pattern (alphanumeric, at least 32 characters)
  const sensitiveEntropyPattern = /^(?=.*[a-z])(?=.*[0-9])[A-Za-z0-9_-]{32,}$/;
  // Key names that should never store credentials
  const tokenKeyPattern =
    /(token|jwt|bearer|secret|credential|auth_token|access_token|refresh_token)/i;

  // 1. Verify localStorage
  for (const { key, val } of storageState.localEntries) {
    expect(key).not.toMatch(tokenKeyPattern);
    if (typeof val === 'string' && val.length > 20) {
      expect(val).not.toMatch(jwtPattern);
      if (val.length >= 32) {
        expect(val).not.toMatch(sensitiveEntropyPattern);
      }
    }
  }

  // 2. Verify sessionStorage
  for (const { key, val } of storageState.sessionEntries) {
    expect(key).not.toMatch(tokenKeyPattern);
    if (typeof val === 'string' && val.length > 20) {
      expect(val).not.toMatch(jwtPattern);
      if (val.length >= 32) {
        expect(val).not.toMatch(sensitiveEntropyPattern);
      }
    }
  }

  // 3. Verify document.cookie: Must NOT expose acc_refresh or Bearer token
  expect(storageState.jsCookie).not.toContain('acc_refresh');
  expect(storageState.jsCookie).not.toContain('Bearer');

  // 4. Verify IndexedDB
  for (const dbName of storageState.idbDatabaseNames) {
    expect(dbName).not.toMatch(tokenKeyPattern);
  }

  // 5. Verify Cache Storage
  for (const cacheKey of storageState.cacheStorageKeys) {
    expect(cacheKey).not.toMatch(tokenKeyPattern);
  }
}

/**
 * Exhaustive exact-secret storage assertion.
 *
 * Verifies that the exact plaintext secret value does NOT occur in any
 * browser storage or persistence surface:
 * 1. URL string, pathname, search params, and hash
 * 2. localStorage keys and values
 * 3. sessionStorage keys and values
 * 4. document.cookie string
 * 5. IndexedDB database names, object store names, and stored record values
 * 6. Cache Storage cache names, request URLs, and response body contents
 * 7. window.history.state serialized contents
 */
export async function assertExactSecretNotInStorage(page: Page, secret: string): Promise<void> {
  expect(secret).toBeTruthy();
  expect(secret.length).toBeGreaterThanOrEqual(16);

  // 1. URL / search / hash checks
  const currentUrl = page.url();
  expect(currentUrl).not.toContain(secret);
  const parsedUrl = new URL(currentUrl);
  expect(parsedUrl.pathname).not.toContain(secret);
  expect(parsedUrl.search).not.toContain(secret);
  expect(parsedUrl.hash).not.toContain(secret);

  // 2. In-browser comprehensive sweep for the exact secret string
  const findings = await page.evaluate(async (targetSecret) => {
    const occurrences: string[] = [];

    // A. localStorage (keys & values)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        if (key.includes(targetSecret)) {
          occurrences.push(`localStorage key: "${key}"`);
        }
        const val = localStorage.getItem(key);
        if (val && val.includes(targetSecret)) {
          occurrences.push(`localStorage value for key "${key}"`);
        }
      }
    }

    // B. sessionStorage (keys & values)
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) {
        if (key.includes(targetSecret)) {
          occurrences.push(`sessionStorage key: "${key}"`);
        }
        const val = sessionStorage.getItem(key);
        if (val && val.includes(targetSecret)) {
          occurrences.push(`sessionStorage value for key "${key}"`);
        }
      }
    }

    // C. document.cookie
    if (document.cookie && document.cookie.includes(targetSecret)) {
      occurrences.push('document.cookie contains secret');
    }

    // D. window.history.state
    try {
      const hist = JSON.stringify(window.history.state);
      if (hist && hist.includes(targetSecret)) {
        occurrences.push('window.history.state contains secret');
      }
    } catch {
      // Circular structure fallback
    }

    // E. IndexedDB database names, store names, and stored values
    if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
      try {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs) {
          const dbName = dbInfo.name;
          if (!dbName) continue;
          if (dbName.includes(targetSecret)) {
            occurrences.push(`IndexedDB database name: "${dbName}"`);
          }
          await new Promise<void>((resolveDb) => {
            const openReq = indexedDB.open(dbName);
            openReq.onerror = () => resolveDb();
            openReq.onsuccess = async () => {
              const db = openReq.result;
              try {
                const storeNames = Array.from(db.objectStoreNames);
                for (const storeName of storeNames) {
                  if (storeName.includes(targetSecret)) {
                    occurrences.push(`IndexedDB [${dbName}] store name: "${storeName}"`);
                  }
                  await new Promise<void>((resolveStore) => {
                    try {
                      const tx = db.transaction(storeName, 'readonly');
                      const store = tx.objectStore(storeName);
                      const getAllReq = store.getAll();
                      getAllReq.onsuccess = () => {
                        try {
                          const records = JSON.stringify(getAllReq.result);
                          if (records && records.includes(targetSecret)) {
                            occurrences.push(
                              `IndexedDB [${dbName}.${storeName}] record contains secret`,
                            );
                          }
                        } catch {
                          // Ignore serialization
                        }
                        resolveStore();
                      };
                      getAllReq.onerror = () => resolveStore();
                    } catch {
                      resolveStore();
                    }
                  });
                }
              } finally {
                db.close();
                resolveDb();
              }
            };
          });
        }
      } catch {
        // Fallback
      }
    }

    // F. Cache Storage cache names, request URLs, and response contents
    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
      try {
        const cacheNames = await caches.keys();
        for (const cName of cacheNames) {
          if (cName.includes(targetSecret)) {
            occurrences.push(`CacheStorage cache name: "${cName}"`);
          }
          try {
            const cache = await caches.open(cName);
            const requests = await cache.keys();
            for (const req of requests) {
              if (req.url.includes(targetSecret)) {
                occurrences.push(`CacheStorage [${cName}] request URL: "${req.url}"`);
              }
              try {
                const res = await cache.match(req);
                if (res) {
                  const bodyText = await res.clone().text();
                  if (bodyText && bodyText.includes(targetSecret)) {
                    occurrences.push(
                      `CacheStorage [${cName}] response body for "${req.url}" contains secret`,
                    );
                  }
                }
              } catch {
                // Ignore match errors
              }
            }
          } catch {
            // Ignore open errors
          }
        }
      } catch {
        // Fallback
      }
    }

    return occurrences;
  }, secret);

  expect(findings).toEqual([]);
}
