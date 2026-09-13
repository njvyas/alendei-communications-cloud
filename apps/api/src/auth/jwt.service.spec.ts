import { JwtService as NestJwtService } from '@nestjs/jwt';
import jwt from 'jsonwebtoken';

import { AccessTokenService } from './jwt.service';

const SECRET = 'a-test-signing-secret-at-least-32-chars-long';
const config = {
  auth: { issuer: 'acc', audience: 'acc-console', accessTokenTtlSeconds: 900 },
  secrets: { jwtSecretRef: 'env:TEST' },
} as never;

function service(): AccessTokenService {
  const svc = new AccessTokenService(config, new NestJwtService({}), {
    resolve: () => Promise.resolve(SECRET),
    backend: 'env',
  } as never);
  svc.setSecretForTesting(SECRET);
  return svc;
}

const claims = (over: Record<string, unknown> = {}) => ({
  sub: 'user-1',
  sid: 'session-1',
  actor_type: 'user',
  jti: 'jti-1',
  iss: 'acc',
  aud: 'acc-console',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 900,
  ...over,
});

describe('AccessTokenService', () => {
  const svc = service();

  it('issues a token that verifies', () => {
    const { token, expiresIn } = svc.issue({ userId: 'u1', sessionId: 's1' });
    expect(expiresIn).toBe(900);
    const verified = svc.verify(token);
    expect(verified.sub).toBe('u1');
    expect(verified.sid).toBe('s1');
    expect(verified.actor_type).toBe('user');
  });

  it('carries identity and session claims only — no authorization snapshot', () => {
    // ADR-003 D-3. Asserted as an exact key set, so adding org_id, roles or
    // permissions to the payload fails here rather than silently becoming an
    // authorization source.
    const { token } = svc.issue({ userId: 'u1', sessionId: 's1' });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(
      ['actor_type', 'aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'sid'].sort(),
    );
    for (const forbidden of ['org_id', 'orgId', 'roles', 'permissions', 'scopes', 'tenant']) {
      expect(decoded).not.toHaveProperty(forbidden);
    }
  });

  it('rejects an expired token as expired, distinguishably', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = jwt.sign(claims({ iat: past - 900, exp: past }), SECRET, { algorithm: 'HS256' });
    expect(() => svc.verify(token)).toThrow(/expired/i);
  });

  it('rejects a wrong issuer', () => {
    const token = jwt.sign(claims({ iss: 'evil' }), SECRET, { algorithm: 'HS256' });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('rejects a wrong audience', () => {
    const token = jwt.sign(claims({ aud: 'someone-else' }), SECRET, { algorithm: 'HS256' });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('rejects the alg=none downgrade', () => {
    const token = jwt.sign(claims(), '', { algorithm: 'none' });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('rejects a token signed with a different algorithm', () => {
    // HS512 with the same secret: a correct signature under the wrong algorithm
    // must still be refused, because the algorithm is pinned.
    const token = jwt.sign(claims(), SECRET, { algorithm: 'HS512' });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('rejects a token signed with a different secret', () => {
    const token = jwt.sign(claims(), 'a-completely-different-secret-value-32', {
      algorithm: 'HS256',
    });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('rejects a tampered payload', () => {
    const { token } = svc.issue({ userId: 'u1', sessionId: 's1' });
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    decoded.sub = 'someone-else';
    const forged = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(() => svc.verify(`${header}.${forged}.${signature}`)).toThrow(/not valid/);
  });

  it.each(['', 'not-a-token', 'a.b', 'a.b.c.d', '...', 'Bearer x'])(
    'rejects the malformed token %p',
    (token) => {
      expect(() => svc.verify(token)).toThrow(/not valid/);
    },
  );

  it('rejects a well-signed token missing the claims it depends on', () => {
    const token = jwt.sign({ iss: 'acc', aud: 'acc-console' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: 900,
    });
    expect(() => svc.verify(token)).toThrow(/not valid/);
  });

  it('never puts the secret in an error it raises', () => {
    try {
      svc.verify('garbage');
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});
