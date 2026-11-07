/**
 * Phase 5.0 PR-E — the header form of the provider webhook ingress (owner-approved contract
 * correction, 07-Nov-2026) and the operator trigger's loopback transport.
 *
 *  - exactly one credential form: path OR `X-Acc-Webhook-Ingress-Key`, never both or neither;
 *  - the header never reaches the ingress service, a log line or a span;
 *  - the trigger posts only to the server's own address and port, on the fixed header-form
 *    path, with the key only in the dedicated header.
 */
import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';

import type { AppConfigService } from '../config/app-config.service';
import { pinoHttpOptions } from '../observability/pino-http-options';
import { loopbackHostFor, postToOwnIngress } from '../providers/provider-simulator-trigger.service';
import { generateIngressKey } from './ingress-key';
import {
  INGRESS_HEADER_ROUTE_TEMPLATE,
  INGRESS_KEY_HEADER,
  INGRESS_ROUTE_TEMPLATE,
  isIngressUrl,
  redactIngressPath,
  redactIngressSpan,
  ingressKeyFrom,
  isIngressHeaderRoute,
  isIngressPath,
  isIngressRoute,
  withoutIngressKeyHeader,
} from './ingress-path';

// Generated per run: nothing key-like is committed (secret scan).
const KEY = generateIngressKey();
const OTHER = generateIngressKey();

describe('ingressKeyFrom: exactly one form', () => {
  it.each<[string, string | null, IncomingHttpHeaders, string]>([
    ['path only', KEY, {}, KEY],
    ['header only', null, { [INGRESS_KEY_HEADER]: KEY }, KEY],
    ['both (even the same value)', KEY, { [INGRESS_KEY_HEADER]: KEY }, ''],
    ['both, different values', KEY, { [INGRESS_KEY_HEADER]: OTHER }, ''],
    ['path and an empty header', KEY, { [INGRESS_KEY_HEADER]: '' }, ''],
    ['neither', null, {}, ''],
    ['an empty header', null, { [INGRESS_KEY_HEADER]: '' }, ''],
    ['a repeated header (array)', null, { [INGRESS_KEY_HEADER]: [KEY, KEY] as never }, ''],
  ])('%s', (_label, pathKey, headers, expected) => {
    expect(ingressKeyFrom(pathKey, headers)).toBe(expected);
  });

  it('removes the key header and nothing else; leaves headers without it untouched', () => {
    const headers = {
      [INGRESS_KEY_HEADER]: KEY,
      'content-type': 'application/json',
      'x-acc-sim-signature': 's',
    };
    const stripped = withoutIngressKeyHeader(headers);
    expect(stripped).toEqual({ 'content-type': 'application/json', 'x-acc-sim-signature': 's' });
    expect(JSON.stringify(stripped)).not.toContain(KEY);
    const plain = { 'content-type': 'application/json' };
    expect(withoutIngressKeyHeader(plain)).toBe(plain);
  });
});

describe('route recognition', () => {
  it('the header-form route is exactly …/webhooks/providers (optional slash and query)', () => {
    for (const url of [
      '/api/v1/webhooks/providers',
      '/api/v1/webhooks/providers/',
      '/api/v1/webhooks/providers?x=1',
    ]) {
      expect([url, isIngressHeaderRoute(url)]).toEqual([url, true]);
    }
    for (const url of [
      `/api/v1/webhooks/providers/${KEY}`,
      '/api/v1/webhooks/providersx',
      '/api/v1/webhooks/other',
      '/api/v1/providers',
    ]) {
      expect([url, isIngressHeaderRoute(url)]).toEqual([url, false]);
    }
    // The URL form is unchanged.
    expect(isIngressRoute(`/api/v1/webhooks/providers/${KEY}`)).toBe(true);
    expect(isIngressPath(`/api/v1/webhooks/providers/${KEY}`)).toBe(true);
    expect(INGRESS_HEADER_ROUTE_TEMPLATE).toBe('/api/v1/webhooks/providers');
  });
});

describe('the header never reaches a log line (real pino-http options)', () => {
  it('request and handler lines carry no key, for the header form and the trigger route', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    const config = {
      logging: { level: 'info', pretty: false },
      serviceName: 'acc-api',
      appEnv: 'test',
    } as unknown as AppConfigService;
    const options = pinoHttpOptions(config);
    const logger = pinoHttp({
      ...options,
      logger: pino({ ...(options as object) }, sink),
    } as never);
    const server = createServer((req, res) => {
      logger(req, res);
      req.log.warn({ msg: 'handler line', headers: req.headers });
      res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      for (const path of [
        '/api/v1/webhooks/providers',
        '/api/v1/providers/x/simulator/delivery-events',
      ]) {
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port,
              method: 'POST',
              path,
              headers: { [INGRESS_KEY_HEADER]: KEY },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve());
            },
          );
          req.on('error', reject);
          req.end('{}');
        });
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).not.toContain(KEY);
    // Both the request serializer's header copy and the handler's ad-hoc copy are redacted.
    const redacted = lines.filter((l) => l.includes(`"${INGRESS_KEY_HEADER}":"[redacted]"`));
    expect(redacted.length).toBeGreaterThanOrEqual(4);
  });
});

describe('tracing never records request headers', () => {
  it('the HTTP instrumentation captures no headers as span attributes', () => {
    const source = readFileSync(join(__dirname, '..', 'observability', 'tracing.ts'), 'utf8');
    expect(source).toContain('new HttpInstrumentation(');
    expect(source).not.toMatch(/headersToSpanAttributes|captureHeaders|requestHeaders/);
  });
});

describe('postToOwnIngress: fixed loopback destination, key only in the header', () => {
  let server: Server;
  let seen: { method?: string; url?: string; headers?: IncomingHttpHeaders; local?: string }[];

  beforeAll(async () => {
    seen = [];
    server = createServer((req, res) => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        local: req.socket.localAddress,
      });
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { received: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('POSTs to the server’s own address and port, on the fixed path; the key only in its header', async () => {
    const outcome = await postToOwnIngress(
      server,
      {
        headers: { 'content-type': 'application/json', 'x-acc-sim-signature': 't=1,v1=00' },
        rawBody: new TextEncoder().encode('{"events":[{}]}'),
      },
      KEY,
    );
    expect(outcome).toEqual({ status: 200, received: 1, errorCode: null });
    expect(seen).toHaveLength(1);
    const [r] = seen;
    expect(r!.method).toBe('POST');
    expect(r!.url).toBe(INGRESS_HEADER_ROUTE_TEMPLATE);
    expect(r!.url).not.toContain(KEY);
    expect(r!.local).toBe('127.0.0.1');
    expect(r!.headers![INGRESS_KEY_HEADER]).toBe(KEY);
    expect(r!.headers!['x-acc-sim-signature']).toBe('t=1,v1=00');
    // The key is in exactly one header.
    const carrying = Object.entries(r!.headers!).filter(([, v]) => String(v).includes(KEY));
    expect(carrying.map(([k]) => k)).toEqual([INGRESS_KEY_HEADER]);
  });

  it('a server that is not listening is refused, with nothing sent', async () => {
    const idle = createServer();
    await expect(
      postToOwnIngress(idle, { headers: {}, rawBody: new Uint8Array() }, KEY),
    ).rejects.toMatchObject({ status: 503 });
  });
});

// =============================================================================
// PR #84 review: strict loopback destination; query strings dropped on both ingress forms.
// =============================================================================

describe('loopbackHostFor: only 127.0.0.1 or ::1, never another address', () => {
  it.each<[string, string | null]>([
    ['0.0.0.0', '127.0.0.1'], // IPv4 wildcard
    ['::', '::1'], // IPv6 (dual-stack) wildcard
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['10.0.0.5', null], // a specific non-loopback interface
    ['192.168.1.20', null],
    ['203.0.113.10', null],
    ['2001:db8::1', null],
    ['fe80::1', null],
    ['127.0.0.2', null], // loopback range, but not reachable through 127.0.0.1
    ['', null],
  ])('bound to %p → %p', (address, expected) => {
    expect(loopbackHostFor({ address })).toBe(expected);
  });
});

describe('postToOwnIngress: real servers on each kind of bind', () => {
  const signed = {
    headers: { 'content-type': 'application/json' },
    rawBody: new TextEncoder().encode('{"events":[{}]}'),
  };

  /** Listens on `host`, or returns null when this machine cannot bind it (e.g. no IPv6). */
  async function listenOn(host: string) {
    const seen: { local?: string; url?: string; key?: unknown }[] = [];
    const server = createServer((req, res) => {
      seen.push({
        local: req.socket.localAddress,
        url: req.url,
        key: req.headers[INGRESS_KEY_HEADER],
      });
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { received: 1 } }));
      });
    });
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, host, () => resolve(true));
    });
    return ok ? { server, seen } : null;
  }
  const close = (server: Server) => new Promise<void>((r) => server.close(() => r()));

  it.each<[string, string]>([
    ['0.0.0.0', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['::', '::1'],
    ['::1', '::1'],
  ])(
    'bound to %s: posted through %s on the fixed path, key only in the header',
    async (bind, via) => {
      const listening = await listenOn(bind);
      if (!listening) {
        // Recorded rather than silently passed: this host cannot bind the address family.
        console.warn(
          `postToOwnIngress: cannot bind ${bind} on this host; covered by loopbackHostFor`,
        );
        return;
      }
      try {
        const outcome = await postToOwnIngress(listening.server, signed, KEY);
        expect(outcome).toEqual({ status: 200, received: 1, errorCode: null });
        expect(listening.seen).toEqual([
          { local: via, url: INGRESS_HEADER_ROUTE_TEMPLATE, key: KEY },
        ]);
      } finally {
        await close(listening.server);
      }
    },
  );

  it('bound to a specific non-loopback interface: 503, nothing sent to it', async () => {
    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === 'IPv4')?.address;
    // The real interface when this host has one; a server reporting a non-loopback bind otherwise.
    const listening = external ? await listenOn(external) : null;
    const reported = {
      address: () => ({ address: '203.0.113.10', family: 'IPv4', port: 9 }),
    } as unknown as Server;
    try {
      for (const server of [listening?.server, reported].filter(Boolean) as Server[]) {
        await expect(postToOwnIngress(server, signed, KEY)).rejects.toMatchObject({
          status: 503,
        });
      }
      if (listening) expect(listening.seen).toEqual([]);
      else
        console.warn('postToOwnIngress: no non-loopback IPv4 interface; reported-bind case only');
    } finally {
      if (listening) await close(listening.server);
    }
  });

  it('not listening, or listening on a pipe: 503, nothing sent', async () => {
    const pipe = { address: () => '/tmp/acc.sock' } as unknown as Server;
    for (const server of [createServer(), pipe]) {
      await expect(postToOwnIngress(server, signed, KEY)).rejects.toMatchObject({ status: 503 });
    }
  });
});

describe('query strings never survive on either ingress form', () => {
  const SECRET = `q-${generateIngressKey()}`;

  it.each<[string, string]>([
    [`/api/v1/webhooks/providers?token=${SECRET}`, '/api/v1/webhooks/providers'],
    [`/api/v1/webhooks/providers/?token=${SECRET}`, '/api/v1/webhooks/providers/'],
    [`/api/v1/webhooks/providers#${SECRET}`, '/api/v1/webhooks/providers'],
    [
      `/api/v1/webhooks/providers/${KEY}?token=${SECRET}`,
      '/api/v1/webhooks/providers/:providerKey',
    ],
    [`/api/v1/webhooks/providers/${KEY}`, '/api/v1/webhooks/providers/:providerKey'],
  ])('redactIngressPath(%s) → %s', (url, redacted) => {
    expect(isIngressUrl(url)).toBe(true);
    expect(redactIngressPath(url)).toBe(redacted);
    expect(redactIngressPath(url)).not.toContain(SECRET);
    expect(redactIngressPath(url)).not.toContain(KEY);
  });

  it('other URLs keep their query (unchanged behaviour)', () => {
    for (const url of ['/api/v1/providers?x=1', '/api/v1/webhooks/providersx?y=2', '/health?z=3']) {
      expect(isIngressUrl(url)).toBe(false);
      expect(redactIngressPath(url)).toBe(url);
    }
  });

  it.each<[string, string, string]>([
    ['header form', `/api/v1/webhooks/providers?token=${SECRET}`, INGRESS_HEADER_ROUTE_TEMPLATE],
    ['URL form', `/api/v1/webhooks/providers/${KEY}?token=${SECRET}`, INGRESS_ROUTE_TEMPLATE],
  ])('span hook, %s: no URL attribute or name keeps the query or key', (_label, url, template) => {
    const attributes: Record<string, string> = {
      'http.target': url,
      'http.url': `http://api.internal${url}`,
      'url.path': url.split('?')[0]!,
      'url.full': `http://api.internal${url}`,
      'url.query': url.split('?')[1] ?? '',
    };
    let name = 'POST';
    redactIngressSpan(
      {
        setAttribute: (k: string, v: string) => {
          attributes[k] = v;
        },
        updateName: (n: string) => {
          name = n;
        },
      },
      { url, method: 'POST' },
    );
    for (const text of [JSON.stringify(attributes), name]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(KEY);
    }
    expect(attributes['url.query']).toBe('');
    expect(attributes['http.route']).toBe(template);
    expect(name).toBe(`POST ${template}`);
  });

  it('request logs (real pino-http options): neither form logs its query, for any status', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(...chunk.toString().split('\n').filter(Boolean));
        done();
      },
    });
    const config = {
      logging: { level: 'info', pretty: false },
      serviceName: 'acc-api',
      appEnv: 'test',
    } as unknown as AppConfigService;
    const options = pinoHttpOptions(config);
    const logger = pinoHttp({
      ...options,
      logger: pino({ ...(options as object) }, sink),
    } as never);
    const server = createServer((req, res) => {
      // As Express leaves the request before the logger binds it: the query already parsed.
      (req as unknown as { query: Record<string, string> }).query = { token: SECRET };
      logger(req, res);
      req.log.info({ msg: 'handler line' });
      res.statusCode = req.url!.includes('/providers/') ? 401 : 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      for (const path of [
        `/api/v1/webhooks/providers?token=${SECRET}`,
        `/api/v1/webhooks/providers/?token=${SECRET}`,
        `/api/v1/webhooks/providers/${KEY}?token=${SECRET}`,
      ]) {
        await new Promise<void>((resolve, reject) => {
          const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path }, (res) => {
            res.resume();
            res.on('end', () => resolve());
          });
          req.on('error', reject);
          req.end('{}');
        });
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(KEY);
    }
    const all = lines.join('\n');
    expect(all).toContain('"url":"/api/v1/webhooks/providers"');
    expect(all).toContain('"url":"/api/v1/webhooks/providers/:providerKey"');
  });
});
