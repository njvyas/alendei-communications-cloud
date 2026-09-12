/**
 * OpenTelemetry bootstrap (`OBSERVABILITY.md` §4).
 *
 * This module is imported for its side effect *before* anything else, because
 * instrumentation must patch `http`, `pg` and `ioredis` before those modules are
 * first required. It therefore reads a small number of raw environment
 * variables directly: the Nest configuration module does not exist yet at this
 * point in the process lifetime.
 *
 * Spans are named per module boundary so a trace mirrors the architectural
 * request flow. Sampling is head-based and configurable; `correlation_id`
 * remains the durable cross-reference for a request even when its trace is
 * sampled out, which is why the two identifiers are kept distinct.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function startTracing(): void {
  if (sdk || !envFlag('OTEL_ENABLED')) return;

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_RATIO ?? '1');
  const samplerRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : 1;

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.SERVICE_NAME ?? 'acc-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.1.0',
      'deployment.environment.name': process.env.APP_ENV ?? 'development',
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(samplerRatio) }),
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation({
        // Scrape and liveness traffic would otherwise dominate the trace volume
        // while telling us nothing.
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return url.startsWith('/metrics') || url.startsWith('/health');
        },
      }),
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();
}

export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown().catch(() => undefined);
  sdk = undefined;
}
