import type { AuthPrincipal } from '@acc/contracts';

import { canonicalize, fingerprint, type EffectiveRequest } from './request-fingerprint';

/**
 * Canonicalization and fingerprinting (`API.md` §4b, Phase 1B.5.9).
 *
 * Two failure modes are being guarded against, and they pull in opposite
 * directions:
 *
 *   **Too strict** — a legitimate retry looks like a different request because a
 *   client library reordered JSON keys, so a safe retry is refused as a payload
 *   mismatch. That failure gets blamed on the server, and rightly.
 *
 *   **Too loose** — two genuinely different requests hash the same, so one
 *   replays the other's response. That is the security failure: a previously
 *   successful request becoming a credential.
 */
describe('request fingerprint', () => {
  const user = (over: Partial<AuthPrincipal> = {}): AuthPrincipal =>
    ({
      actorType: 'user',
      userId: '11111111-1111-7111-8111-111111111111',
      apiKeyId: null,
      sessionId: null,
      tenant: {
        orgId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
        workspaceId: null,
        resellerId: null,
        isPlatformAdmin: false,
      },
      roles: [],
      permissions: [],
      ...over,
    }) as AuthPrincipal;

  const request = (over: Partial<EffectiveRequest> = {}): EffectiveRequest => ({
    method: 'POST',
    route: '/roles',
    orgId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    principal: user(),
    pathParams: {},
    query: {},
    body: { key: 'a_role', name: 'A', permissions: ['roles.read'] },
    ...over,
  });

  // --- canonicalization -----------------------------------------------------

  describe('canonicalization', () => {
    it('is insensitive to object key order, at every depth', () => {
      // The single most important property. A client library or proxy that
      // re-serialises JSON must not turn a safe retry into a mismatch.
      expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
        canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
      );
    });

    it('preserves array order', () => {
      // `[a, b]` and `[b, a]` are different requests. Treating them as equal
      // would let a key be reused for a request the caller never made.
      expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
    });

    it('treats an absent property and an explicit undefined as the same', () => {
      expect(canonicalize({ a: 1 })).toBe(canonicalize({ a: 1, b: undefined }));
    });

    it('treats an explicit null as present and distinct from absent', () => {
      expect(canonicalize({ a: 1, b: null })).not.toBe(canonicalize({ a: 1 }));
    });

    it('does not confuse a number with its string form', () => {
      expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: '1' }));
    });

    it('does not confuse a nested object with a flattened key', () => {
      expect(canonicalize({ a: { b: 1 } })).not.toBe(canonicalize({ 'a.b': 1 }));
    });

    it('is stable across repeated calls', () => {
      const value = { z: [3, 2, 1], a: { n: null, m: 'x' } };
      expect(canonicalize(value)).toBe(canonicalize(value));
    });

    it('renders a date by its instant, not its local formatting', () => {
      const iso = '2026-09-16T00:00:00.000Z';
      expect(canonicalize(new Date(iso))).toBe(JSON.stringify(iso));
    });
  });

  // --- stability ------------------------------------------------------------

  describe('stability — the same request hashes the same', () => {
    it('for an identical request', () => {
      expect(fingerprint(request())).toBe(fingerprint(request()));
    });

    it('when only the body’s key order differs', () => {
      const a = request({ body: { key: 'a_role', name: 'A' } });
      const b = request({ body: { name: 'A', key: 'a_role' } });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('when the principal carries different roles or permissions', () => {
      // Identity is what binds a key, not the grants that happen to be resolved
      // on this request — otherwise an unrelated grant change would make a safe
      // retry look like a different request.
      const a = request({ principal: user({ roles: [], permissions: [] }) });
      const b = request({
        principal: user({ permissions: ['roles.read'] as never }),
      });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });

    it('when the session differs for the same user', () => {
      // A retry after re-authenticating is still the same request.
      const a = request({ principal: user({ sessionId: 'session-one' as never }) });
      const b = request({ principal: user({ sessionId: 'session-two' as never }) });
      expect(fingerprint(a)).toBe(fingerprint(b));
    });
  });

  // --- difference -----------------------------------------------------------

  describe('difference — a different request hashes differently', () => {
    it('for a different body', () => {
      expect(fingerprint(request())).not.toBe(
        fingerprint(request({ body: { key: 'other_role', name: 'A' } })),
      );
    });

    it('for a different route — endpoint binding', () => {
      expect(fingerprint(request())).not.toBe(fingerprint(request({ route: '/role-assignments' })));
    });

    it('for a different method', () => {
      expect(fingerprint(request())).not.toBe(fingerprint(request({ method: 'PATCH' })));
    });

    it('for a different organization — tenant binding', () => {
      expect(fingerprint(request())).not.toBe(
        fingerprint(request({ orgId: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb' })),
      );
    });

    it('for a different user — principal binding', () => {
      // The security property. Within one organization the key scope is shared,
      // so without this a second principal could present another's key and
      // receive its stored response.
      expect(fingerprint(request())).not.toBe(
        fingerprint(
          request({ principal: user({ userId: '22222222-2222-7222-8222-222222222222' }) }),
        ),
      );
    });

    it('for an API key rather than the user who created it', () => {
      const asKey = user({
        actorType: 'api_key' as never,
        userId: null,
        apiKeyId: '33333333-3333-7333-8333-333333333333' as never,
      });
      expect(fingerprint(request())).not.toBe(fingerprint(request({ principal: asKey })));
    });

    it('for a different API key', () => {
      const keyOne = user({
        actorType: 'api_key' as never,
        userId: null,
        apiKeyId: '33333333-3333-7333-8333-333333333333' as never,
      });
      const keyTwo = user({
        actorType: 'api_key' as never,
        userId: null,
        apiKeyId: '44444444-4444-7444-8444-444444444444' as never,
      });
      expect(fingerprint(request({ principal: keyOne }))).not.toBe(
        fingerprint(request({ principal: keyTwo })),
      );
    });

    it('for different path parameters', () => {
      expect(fingerprint(request({ pathParams: { id: 'one' } }))).not.toBe(
        fingerprint(request({ pathParams: { id: 'two' } })),
      );
    });

    it('for different query parameters', () => {
      expect(fingerprint(request({ query: { a: '1' } }))).not.toBe(
        fingerprint(request({ query: { a: '2' } })),
      );
    });
  });

  it('is a hex SHA-256 digest', () => {
    expect(fingerprint(request())).toMatch(/^[0-9a-f]{64}$/);
  });
});
