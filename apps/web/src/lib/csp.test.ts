import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { apiOrigin, buildContentSecurityPolicy, createNonce } from './csp';

const directives = (policy: string) =>
  Object.fromEntries(policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));

describe('U15.1 Content Security Policy', () => {
  it('production: nonce-only scripts, no unsafe-inline/unsafe-eval for scripts, API origin allowed', () => {
    const nonce = createNonce();
    const d = directives(
      buildContentSecurityPolicy({
        nonce,
        isDevelopment: false,
        apiBaseUrl: 'https://qa.example.test/api/v1',
      }),
    );
    assert.deepEqual(d['script-src'], ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]);
    assert.ok(!d['script-src']!.includes("'unsafe-inline'"));
    assert.ok(!d['script-src']!.includes("'unsafe-eval'"));
    assert.deepEqual(d['connect-src'], ["'self'", 'https://qa.example.test']);
    assert.deepEqual(d['object-src'], ["'none'"]);
    assert.deepEqual(d['frame-ancestors'], ["'none'"]);
    assert.deepEqual(d['base-uri'], ["'self'"]);
    assert.deepEqual(d['form-action'], ["'self'"]);
  });

  it('development adds only unsafe-eval (React debugging) and websocket connections (HMR)', () => {
    const d = directives(buildContentSecurityPolicy({ nonce: createNonce(), isDevelopment: true }));
    assert.ok(d['script-src']!.includes("'unsafe-eval'"));
    assert.deepEqual(d['connect-src'], ["'self'", 'ws:', 'wss:']);
  });

  it('nonces are fresh, 128-bit base64; malformed nonces are refused', () => {
    const a = createNonce();
    const b = createNonce();
    assert.notEqual(a, b);
    assert.equal(Buffer.from(a, 'base64').length, 16);
    assert.throws(() =>
      buildContentSecurityPolicy({ nonce: "x' 'unsafe-inline", isDevelopment: false }),
    );
    assert.throws(() => buildContentSecurityPolicy({ nonce: 'short', isDevelopment: false }));
  });

  it('only http(s) API URLs contribute an origin', () => {
    assert.equal(apiOrigin('http://localhost:3001/api/v1'), 'http://localhost:3001');
    assert.equal(apiOrigin('javascript:alert(1)'), null);
    assert.equal(apiOrigin('not a url'), null);
    assert.equal(apiOrigin(undefined), null);
  });
});
