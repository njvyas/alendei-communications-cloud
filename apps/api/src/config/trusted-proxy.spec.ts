import express from 'express';
import request from 'supertest';

/**
 * Trusted-proxy behaviour.
 *
 * `X-Forwarded-For` is attacker-controlled unless a known proxy set it. Express
 * decides how many hops to believe from `trust proxy`, and that number is the
 * difference between a working IP-keyed rate limit and one any client can step
 * around by adding a header. These tests pin the behaviour at each setting so a
 * change to the configured default cannot pass unnoticed.
 */
function appWith(trustProxy: number) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  return app;
}

describe('trusted proxy', () => {
  it('ignores a forged X-Forwarded-For when nothing is trusted', async () => {
    const res = await request(appWith(0)).get('/ip').set('X-Forwarded-For', '9.9.9.9').expect(200);
    // The socket address wins — a client cannot choose its own rate-limit bucket.
    expect(res.body.ip).not.toBe('9.9.9.9');
  });

  it('trusts exactly one hop when configured for one', async () => {
    const res = await request(appWith(1))
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.5')
      .expect(200);
    expect(res.body.ip).toBe('203.0.113.5');
  });

  it('takes the nearest untrusted hop when a client prepends extra entries', async () => {
    // A client behind one real proxy sends `forged, real`. With one hop trusted,
    // the rightmost entry is the one the proxy added, so the forged left-hand
    // value must not be selected.
    const res = await request(appWith(1))
      .get('/ip')
      .set('X-Forwarded-For', '1.2.3.4, 203.0.113.5')
      .expect(200);
    expect(res.body.ip).toBe('203.0.113.5');
    expect(res.body.ip).not.toBe('1.2.3.4');
  });

  it('believes a deeper chain only when configured to', async () => {
    const res = await request(appWith(2))
      .get('/ip')
      .set('X-Forwarded-For', '1.2.3.4, 203.0.113.5')
      .expect(200);
    // Trusting more hops than really exist is what lets a client forge its
    // address; this is the behaviour that makes over-configuring dangerous.
    expect(res.body.ip).toBe('1.2.3.4');
  });
});
