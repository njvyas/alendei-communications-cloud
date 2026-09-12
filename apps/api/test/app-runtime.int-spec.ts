/**
 * Runtime acceptance for the Phase 1A foundation, exercised through the real
 * application: health/readiness/liveness, the error envelope, correlation
 * propagation and the metrics endpoint.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { validationPipe } from '../src/common/http/validation.pipe';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

describe('API runtime', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(validationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    app.setGlobalPrefix('api/v1', {
      exclude: ['metrics', 'health', 'health/live', 'health/ready'],
    });
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  }, 30_000);

  describe('health', () => {
    it('reports liveness without touching a dependency', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);
      expect(response.body).toEqual({ status: 'ok', service: expect.any(String) });
    });

    it('reports readiness including PostgreSQL', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.info.postgres.status).toBe('up');
    });

    it('serves aggregate health', async () => {
      await request(app.getHttpServer()).get('/health').expect(200);
    });

    it('discloses no version or topology detail on the liveness probe', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);
      expect(Object.keys(response.body).sort()).toEqual(['service', 'status']);
    });
  });

  describe('error contract', () => {
    it('returns the documented envelope for an unknown route', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/nonexistent').expect(404);

      expect(response.body.error).toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        retryable: false,
      });
      expect(response.body.error.correlationId).toEqual(expect.any(String));
      expect(typeof response.body.error.message).toBe('string');
    });

    it('never leaks a stack trace or internal field to the client', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/nonexistent').expect(404);
      const serialized = JSON.stringify(response.body);

      expect(serialized).not.toMatch(/\bat \/|node_modules|\.ts:\d+/);
      expect(Object.keys(response.body)).toEqual(['error']);
    });
  });

  describe('correlation', () => {
    it('generates a correlation id when the caller supplies none', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(response.headers['x-correlation-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(response.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('honours a well-formed caller-supplied correlation id', async () => {
      const supplied = '0199a000-0000-7000-8000-000000000001';
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .set('x-correlation-id', supplied)
        .expect(200);

      expect(response.headers['x-correlation-id']).toBe(supplied);
    });

    it('replaces a malformed correlation id rather than propagating it', async () => {
      // Otherwise a caller could inject arbitrary text into log lines, event
      // envelopes and audit records.
      const response = await request(app.getHttpServer())
        .get('/health/live')
        .set('x-correlation-id', 'not-a-uuid-injected-value')
        .expect(200);

      expect(response.headers['x-correlation-id']).not.toContain('injected');
      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('gives each request its own request id', async () => {
      const [a, b] = await Promise.all([
        request(app.getHttpServer()).get('/health/live'),
        request(app.getHttpServer()).get('/health/live'),
      ]);
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });
  });

  describe('metrics', () => {
    it('exposes Prometheus metrics outside the versioned prefix', async () => {
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);
      expect(response.text).toContain('acc_http_requests_total');
    });

    it('labels requests by route pattern and status class only', async () => {
      await request(app.getHttpServer()).get('/health/live');
      const response = await request(app.getHttpServer()).get('/metrics').expect(200);

      const series = response.text
        .split('\n')
        .filter((line) => line.startsWith('acc_http_requests_total{'));
      expect(series.length).toBeGreaterThan(0);

      for (const line of series) {
        // A concrete status code or an identifier here would be a cardinality
        // blow-up waiting to happen (OBSERVABILITY.md §3).
        expect(line).toMatch(/status="[1-5]xx"/);
        expect(line).not.toMatch(/(org_id|tenant_id|user_id|correlation_id|request_id)=/);
      }
    });
  });
});
