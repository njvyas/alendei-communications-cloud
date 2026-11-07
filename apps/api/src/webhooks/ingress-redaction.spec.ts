/**
 * Phase 5.0 PR-C — the ingress key never reaches a log line or a span (spec §E.8, AC-SV-6;
 * OD-19 application side). The reverse-proxy side is verified by
 * `deploy/nginx/verify-webhook-redaction.sh`.
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoHttp from 'pino-http';

import type { AppConfigService } from '../config/app-config.service';
import { pinoHttpOptions } from '../observability/pino-http-options';
import { generateIngressKey, hashIngressKey, MAX_INGRESS_KEY_LENGTH } from './ingress-key';
import {
  INGRESS_ROUTE_TEMPLATE,
  isIngressPath,
  redactIngressPath,
  redactIngressSpan,
} from './ingress-path';

// A real-format key generated per run: nothing key-like is committed (secret scan).
const KEY = generateIngressKey();

describe('redactIngressPath', () => {
  it.each([
    [`/api/v1/webhooks/providers/${KEY}`, '/api/v1/webhooks/providers/:providerKey'],
    [`/api/v1/webhooks/providers/${KEY}?token=${KEY}`, '/api/v1/webhooks/providers/:providerKey'],
    [`/webhooks/providers/${KEY}#frag`, '/webhooks/providers/:providerKey'],
    [`/API/V1/WEBHOOKS/PROVIDERS/${KEY}`, '/API/V1/WEBHOOKS/PROVIDERS/:providerKey'],
  ])('%s → %s', (url, redacted) => {
    expect(isIngressPath(url)).toBe(true);
    expect(redactIngressPath(url)).toBe(redacted);
    expect(redactIngressPath(url)).not.toContain(KEY);
  });

  it('leaves every other URL, and non-strings, untouched', () => {
    for (const url of ['/api/v1/providers/abc?x=1', '/health', '/api/v1/webhooks/other/x']) {
      expect(isIngressPath(url)).toBe(false);
      expect(redactIngressPath(url)).toBe(url);
    }
    expect(redactIngressPath(undefined)).toBeUndefined();
    expect(redactIngressPath(null)).toBeNull();
  });
});

describe('redactIngressSpan (OpenTelemetry HTTP request hook)', () => {
  /** A span as the HTTP instrumentation leaves it before the hook runs: raw URL everywhere. */
  function instrumentedSpan(url: string) {
    const attributes: Record<string, string> = {
      'http.target': url,
      'http.url': `http://api.internal${url}`,
      'url.path': url.split('?')[0]!,
      'url.full': `http://api.internal${url}`,
      'url.query': url.split('?')[1] ?? '',
      'http.method': 'POST',
    };
    let name = 'POST';
    return {
      attributes,
      get name() {
        return name;
      },
      setAttribute: (k: string, v: string) => {
        attributes[k] = v;
      },
      updateName: (n: string) => {
        name = n;
      },
    };
  }

  it('overwrites every URL-bearing attribute and the name; http.route is the template', () => {
    const span = instrumentedSpan(`/api/v1/webhooks/providers/${KEY}?k=${KEY}`);
    redactIngressSpan(span, { url: `/api/v1/webhooks/providers/${KEY}?k=${KEY}`, method: 'POST' });
    expect(JSON.stringify(span.attributes)).not.toContain(KEY);
    expect(span.name).not.toContain(KEY);
    expect(span.attributes['http.route']).toBe(INGRESS_ROUTE_TEMPLATE);
    expect(span.attributes['url.path']).toBe('/api/v1/webhooks/providers/:providerKey');
    expect(span.name).toBe(`POST ${INGRESS_ROUTE_TEMPLATE}`);
  });

  it('does not touch other requests', () => {
    const span = instrumentedSpan('/api/v1/providers?x=1');
    const before = { ...span.attributes };
    redactIngressSpan(span, { url: '/api/v1/providers?x=1', method: 'GET' });
    expect(span.attributes).toEqual(before);
    expect(span.name).toBe('POST');
  });
});

describe('request logging with the real pino-http options (AC-SV-6)', () => {
  let server: Server;
  let lines: string[];

  beforeAll(async () => {
    lines = [];
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
    server = createServer((req, res) => {
      // What Express has done before the logging middleware runs (pino-http serializes the
      // request when it binds its logger): parsed the query. Params are set by the router too.
      // The end-to-end run found the query echoed until the serializer dropped it.
      (req as unknown as { query: Record<string, string> }).query = { token: KEY };
      (req as unknown as { params: Record<string, string> }).params = { providerKey: KEY };
      logger(req, res);
      req.log.warn({ msg: 'handler line' });
      res.statusCode = 401;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('no request or response log line carries the key; the redacted path is logged instead', async () => {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/v1/webhooks/providers/${KEY}?token=${KEY}`,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).not.toContain(KEY);
    expect(lines.join('\n')).toContain('/api/v1/webhooks/providers/:providerKey');
  });
});

describe('ingress keys (OD-6)', () => {
  it('a key is 256 random bits, base64url; never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, generateIngressKey));
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(43).toBeLessThan(MAX_INGRESS_KEY_LENGTH);
  });

  it('the stored form is HMAC-SHA256(pepper, key): 32 bytes, deterministic, pepper-dependent', () => {
    const key = generateIngressKey();
    const a = hashIngressKey('pepper-one-pepper-one-pepper-one-01', key);
    expect(a).toHaveLength(32);
    expect(hashIngressKey('pepper-one-pepper-one-pepper-one-01', key).equals(a)).toBe(true);
    expect(hashIngressKey('pepper-two-pepper-two-pepper-two-02', key).equals(a)).toBe(false);
    expect(a.toString('utf8')).not.toContain(key);
  });
});
