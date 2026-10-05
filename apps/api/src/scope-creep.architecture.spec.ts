import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PROVIDER_ADAPTER_KEYS } from '@acc/contracts';

/**
 * Gate D "No scope creep" (`ROADMAP.md` §5c, `TESTING.md` §6u, ADR-013): Phase 2
 * introduces no outbox, worker harness, SIEM export, routing/failover, billing,
 * real provider adapter or network call, message lifecycle, reseller/white-label
 * provider administration or WebSocket gateway.
 *
 * Each category is a pattern over the backend source with comments stripped
 * (documentation may describe later phases; code may not). Every match that
 * already exists is pinned, file by file, with the reason it is legitimate; any
 * new match fails until it is reviewed. Structural pins — the API module list,
 * the adapter files and keys, the tables every migration creates and the
 * declared dependencies — catch what a name pattern cannot.
 */
const ROOT = join(__dirname, '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return path.endsWith('.ts') && !/\.(spec|int-spec|sec-spec)\.ts$/.test(path) ? [path] : [];
  });
}
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const files = ['apps/api/src', 'packages/contracts/src', 'packages/db/src']
  .flatMap((dir) => sources(join(ROOT, dir)))
  .map((path) => ({ rel: relative(ROOT, path), text: strip(readFileSync(path, 'utf8')) }));
const isProviderCode = (rel: string) =>
  /^apps\/api\/src\/(providers|provider-adapters)\//.test(rel) ||
  /^packages\/contracts\/src\/(provider[\w-]*|providers)\.ts$/.test(rel) ||
  rel === 'packages/db/src/schema/providers.ts';

interface Category {
  key: string;
  forbids: string;
  exceptions: string;
  pattern: RegExp;
  providerCodeOnly: boolean;
  pinned: Record<string, string[]>;
}

const CATEGORIES: Category[] = [
  {
    key: 'outbox',
    forbids: 'the transactional outbox and event publication (ADR-013 PD-1)',
    exceptions:
      'Pre-existing, not Phase 2: Phase 0/1 relay and Kafka configuration keys, the `acc_relay` database role, and outbox metrics that are defined but never incremented; `published` in the adapter registry is the published adapter-key list. No outbox table, relay loop, producer or publish call exists.',
    pattern: /[\w-]*(?:outbox|relay|publish|kafka|producer|event_?bus)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/cli/dev-fixture/run.ts': ['OUTBOX_RELAY_ENABLED'],
      'apps/api/src/config/app-config.service.ts': [
        'DATABASE_RELAY_URL',
        'KAFKA_BROKERS',
        'KAFKA_CLIENT_ID',
        'KAFKA_SSL',
        'OUTBOX_RELAY_BATCH_SIZE',
        'OUTBOX_RELAY_ENABLED',
        'OUTBOX_RELAY_MAX_ATTEMPTS',
        'OUTBOX_RELAY_POLL_INTERVAL_MS',
        'relayBatchSize',
        'relayEnabled',
        'relayMaxAttempts',
        'relayPollIntervalMs',
        'relayUrl',
      ],
      'apps/api/src/config/env.schema.ts': [
        'DATABASE_RELAY_URL',
        'KAFKA_BROKERS',
        'KAFKA_CLIENT_ID',
        'KAFKA_SSL',
        'OUTBOX_RELAY_BATCH_SIZE',
        'OUTBOX_RELAY_ENABLED',
        'OUTBOX_RELAY_MAX_ATTEMPTS',
        'OUTBOX_RELAY_POLL_INTERVAL_MS',
      ],
      'apps/api/src/observability/metrics.service.ts': [
        'Outbox',
        'acc_events_published_total',
        'acc_outbox_backlog',
        'eventsPublished',
        'outbox',
        'outboxBacklog',
        'published',
      ],
      'apps/api/src/openapi/openapi-cli.ts': ['KAFKA_BROKERS'],
      'apps/api/src/provider-adapters/adapter-registry.ts': ['published'],
      'packages/db/src/cli/migrate.ts': ['DATABASE_RELAY_PASSWORD', 'RELAY', 'relayPassword'],
      'packages/db/src/constants.ts': ['RELAY', 'acc_relay'],
    },
  },
  {
    key: 'worker',
    forbids:
      'a worker/job harness or new messaging worker infrastructure (ADR-013 PD-1, ADR-004 D-5)',
    exceptions:
      'Pre-existing: the hot-reload listener reconnect timer and an ioredis option. No queue, processor, cron, interval or job runner exists; `@nestjs/schedule` is a declared but unused dependency (pinned below).',
    pattern: /[\w-]*(?:worker|queue|bullmq|processor|cron|setInterval|schedul|job)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/providers/provider-configuration.listener.ts': ['scheduleReconnect'],
      'apps/api/src/redis/redis.module.ts': ['enableOfflineQueue'],
    },
  },
  {
    key: 'siem',
    forbids: 'SIEM export (ADR-013 PD-1)',
    exceptions: 'None exist.',
    pattern: /[\w-]*(?:siem|splunk|syslog|opensearch|elastic)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {},
  },
  {
    key: 'routing',
    forbids: 'provider routing, failover, weights, priorities or canary (ADR-013 PD-4, PD-6)',
    exceptions:
      'Pre-existing: HTTP error-status fallbacks and a tracing fallback; the approved routing-eligibility contract (`routingEligibility`, `PROVIDER_ADAPTER.md` \u00a76h) and the advisory in-process candidate view (\u00a73a.1). Neither routes or fails over.',
    pattern: /[\w-]*(?:rout(?:er|ing)|failover|fallback|priorit|weight|canary)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/common/filters/all-exceptions.filter.ts': ['STATUS_CODE_FALLBACKS', 'fallback'],
      'apps/api/src/observability/tracing.ts': ['fallback'],
      'apps/api/src/providers/provider-catalogue.service.ts': [
        'RoutingCandidatesView',
        'routingCandidates',
      ],
      'apps/api/src/providers/provider-state-machine.ts': [
        'RoutingEligibility',
        'routingEligibility',
      ],
    },
  },
  {
    key: 'billing',
    forbids: 'billing or rating (ADR-013 PD-6)',
    exceptions:
      'Pre-existing: the organization billing mode and policy fields (Phase 1C; no rating or charging) and the `estimateCost` interface member, which the simulator refuses (PD-6).',
    pattern:
      /[\w-]*(?:billing|rating|ledger|invoice|wallet|tariff|estimate_?cost|charge|pricing|price)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/metadata.ts': [
        'billingMode',
        'billingPolicy',
        'charge_per_attempt',
        'charge_per_logical_message',
      ],
      'apps/api/src/openapi/openapi-schemas.ts': [
        'BILLING_MODES',
        'BILLING_POLICIES',
        'billingMode',
        'billingPolicy',
      ],
      'apps/api/src/organizations/organization-administration.service.ts': [
        'billingMode',
        'billingPolicy',
        'wantsBilling',
      ],
      'apps/api/src/organizations/organization.dto.ts': [
        'BILLING_MODES',
        'BILLING_POLICIES',
        'billingMode',
        'billingPolicy',
        'charge_per_attempt',
        'charge_per_logical_message',
      ],
      'apps/api/src/provider-adapters/simulator.adapter.ts': ['estimateCost'],
      'packages/contracts/src/provider-adapter.ts': ['estimateCost'],
      'packages/db/src/schema/tenancy.ts': [
        'billingMode',
        'billingPolicy',
        'billing_mode',
        'billing_policy',
        'charge_per_attempt',
        'charge_per_logical_message',
      ],
    },
  },
  {
    key: 'network',
    forbids: 'real provider adapters or outbound network calls (ADR-013 F-9)',
    exceptions:
      "Pre-existing: the dev fixtures' clients for the local in-process API (Phase 1C.4a, and the Phase 2.6 provider-console fixture), and the Express route registration of the dev-only Swagger UI. No provider-facing network call exists; the only adapter key is `simulator` (pinned below).",
    pattern:
      /(?:\bfetch\s*\(|axios|undici|\bhttps?\.(?:request|get)\s*\(|XMLHttpRequest|net\.connect|tls\.connect|dgram|twilio|gupshup|karix|sendgrid|infobip|vonage|plivo|msg91|kaleyra|nodemailer|smtp|graph\.facebook)/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/cli/dev-fixture/api-client.ts': ['fetch('],
      'apps/api/src/cli/provider-fixture/api-client.ts': ['fetch('],
      'apps/api/src/openapi/openapi-dev-ui.ts': ['http.get('],
    },
  },
  {
    key: 'lifecycle',
    forbids: 'the message lifecycle \u2014 messages, attempts, delivery, webhooks (ADR-013 PD-3)',
    exceptions:
      'Pre-existing: the `checkStatus`/`parseWebhook` interface members, which the simulator refuses (PD-6), a role description and a forbidden metric label name. No message, attempt, delivery or webhook code exists.',
    pattern:
      /[\w-]*(?:message_?attempt|webhook|deliver|dlr|checkStatus|parseWebhook|inbound_?message|conversation)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/observability/metrics.service.ts': ['conversation_id'],
      'apps/api/src/provider-adapters/simulator.adapter.ts': ['checkStatus', 'parseWebhook'],
      'packages/contracts/src/provider-adapter.ts': ['checkStatus', 'parseWebhook'],
      'packages/contracts/src/roles.ts': ['Conversation'],
    },
  },
  {
    key: 'resellerProvider',
    forbids:
      'reseller or white-label provider administration (ADR-013 PD-5, PD-6) \u2014 provider code only',
    exceptions:
      "Pre-existing: provider-access attributes a refusal to the caller's own organization or reseller in the audit trail; it never scopes a provider. The catalogue has no tenant column.",
    pattern: /[\w-]*(?:reseller|white_?label|whitelabel|org_?id|organization)[\w-]*/gi,
    providerCodeOnly: true,
    pinned: {
      'apps/api/src/providers/provider-access.service.ts': [
        'orgId',
        'organization',
        'reseller',
        'resellerId',
      ],
    },
  },
  {
    key: 'websocket',
    forbids: 'a WebSocket gateway (D15, ADR-013 PD-8)',
    exceptions:
      'Pre-existing: the WebSocket **ticket** mint (Phase 1B, D15 \u2014 a ticket can be issued, never consumed: no gateway, no upgrade handler) and two unrelated `ws` aliases (a workspace slug and a list-query local).',
    pattern:
      /[\w-]*(?:websocket|socket\.io|WebSocketGateway|upgrade|\bws\b|ws[-_]?ticket|wss?:)[\w-]*/gi,
    providerCodeOnly: false,
    pinned: {
      'apps/api/src/cli/dev-fixture/inspect.ts': ['ws'],
      'apps/api/src/common/http/list-query.ts': ['rows:'],
      'apps/api/src/config/app-config.service.ts': [
        'AUTH_WS_TICKET_TTL_SECONDS',
        'wsTicketTtlSeconds',
      ],
      'apps/api/src/config/env.schema.ts': ['AUTH_WS_TICKET_TTL_SECONDS'],
      'apps/api/src/iam/iam.module.ts': ['WsTicketController', 'WsTicketService', 'ws-ticket'],
      'apps/api/src/iam/index.ts': ['ws-ticket'],
      'apps/api/src/iam/ws-ticket.controller.ts': [
        'WebSocket',
        'WsTicketController',
        'WsTicketSchema',
        'WsTicketService',
        'websocket',
        'ws',
        'ws-ticket',
      ],
      'apps/api/src/iam/ws-ticket.service.ts': [
        'WS_TICKET_ISSUED',
        'WebSocket',
        'WsTicket',
        'WsTicketService',
        'WsTicketView',
        'issueWsTicket',
        'ws',
        'ws-ticket',
        'wsTicketTtlSeconds',
        'wsTickets',
      ],
      'apps/api/src/iam/ws-ticket.ts': ['WsTicketMaterial', 'hashWsTicket', 'issueWsTicket'],
      'apps/api/src/metadata.ts': ['WsTicketController', 'ws-ticket'],
      'apps/api/src/openapi/openapi-schemas.ts': ['WsTicket', 'WsTicketSchema'],
      'packages/contracts/src/audit.ts': [
        'WS_TICKET_CONSUMED',
        'WS_TICKET_ISSUED',
        'WS_TICKET_REJECTED',
        'ws_ticket',
      ],
      'packages/contracts/src/errors.ts': [
        'WS_TICKET_ALREADY_CONSUMED',
        'WS_TICKET_EXPIRED',
        'WS_TICKET_INVALID',
      ],
      'packages/db/src/schema/iam.ts': [
        'NewWsTicket',
        'WsTicket',
        'wsTickets',
        'ws_tickets',
        'ws_tickets_expires_at_idx',
        'ws_tickets_org_id_idx',
        'ws_tickets_scope_is_array',
        'ws_tickets_ticket_hash_key',
        'ws_tickets_ttl_positive',
        'ws_tickets_workspace_org_fk',
      ],
    },
  },
];

function found(category: Category): Record<string, string[]> {
  const byFile: Record<string, Set<string>> = {};
  for (const f of files.filter((f) => !category.providerCodeOnly || isProviderCode(f.rel))) {
    for (const m of f.text.matchAll(category.pattern)) (byFile[f.rel] ??= new Set()).add(m[0]);
  }
  return Object.fromEntries(
    Object.keys(byFile)
      .sort()
      .map((rel) => [rel, [...byFile[rel]!].sort()]),
  );
}

describe('Gate D — Phase 2 introduces no out-of-scope capability (no scope creep)', () => {
  it('scans the whole backend', () => {
    expect(files.length).toBeGreaterThan(150);
    expect(files.filter((f) => isProviderCode(f.rel)).length).toBeGreaterThan(20);
  });

  it.each(CATEGORIES.map((c) => [c.key, c] as const))(
    'no new %s code beyond the pinned, pre-existing exceptions',
    (_key, category) => {
      expect(found(category)).toEqual(category.pinned);
    },
  );

  it('the API modules are exactly the Phase 0–2 set: no outbox, worker, routing, billing, messaging, webhook or gateway module', () => {
    const modules = readdirSync(join(ROOT, 'apps/api/src'))
      .filter((n) => statSync(join(ROOT, 'apps/api/src', n)).isDirectory())
      .sort();
    expect(modules).toEqual([
      'api-keys',
      'audit',
      'audit-read',
      'auth',
      'cli',
      'common',
      'config',
      'database',
      'health',
      'iam',
      'idempotency',
      'observability',
      'openapi',
      'organizations',
      'provider-adapters',
      'providers',
      'rbac',
      'redis',
      'secrets',
      'tenancy',
      'users',
      'workspaces',
    ]);
  });

  it('the only provider adapter is the simulator, and the adapter module holds nothing else', () => {
    expect([...PROVIDER_ADAPTER_KEYS]).toEqual(['simulator']);
    const adapterFiles = readdirSync(join(ROOT, 'apps/api/src/provider-adapters'))
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))
      .sort();
    expect(adapterFiles).toEqual([
      'adapter-registry.ts',
      'circuit-admission.ts',
      'provider-adapters.module.ts',
      'simulator.adapter.ts',
      'submission-executor.ts',
      'submission-timer.ts',
    ]);
  });

  it('the migrations create exactly the Phase 0–2 tables: no outbox, job, message, attempt, webhook, billing, routing or SIEM table', () => {
    const dir = join(ROOT, 'packages/db/migrations');
    const created = new Set<string>();
    for (const name of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n))) {
      const sql = readFileSync(join(dir, name), 'utf8').replace(/--.*$/gm, '');
      for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi))
        created.add(m[1]!.toLowerCase());
    }
    expect([...created].sort()).toEqual([
      'api_keys',
      'audit_logs',
      'channels',
      'idempotency_keys',
      'organizations',
      'permissions',
      'provider_capabilities',
      'provider_circuit_policy',
      'provider_configuration_revision',
      'provider_health',
      'providers',
      'resellers',
      'role_permissions',
      'roles',
      'sessions',
      'teams',
      'user_roles',
      'users',
      'workspaces',
      'ws_tickets',
    ]);
  });

  it('the declared dependencies are exactly the pinned set: no queue, WebSocket, HTTP-client, vendor-SDK or billing library', () => {
    const declared = (pkg: string) => {
      const json = JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Object.keys({ ...json.dependencies, ...json.devDependencies }).sort();
    };
    // kafkajs and @nestjs/schedule are pre-existing Phase 0 declarations, imported nowhere (the
    // outbox and worker patterns above prove it).
    expect(declared('apps/api')).toEqual([
      '@acc/contracts',
      '@acc/db',
      '@nestjs/cli',
      '@nestjs/common',
      '@nestjs/config',
      '@nestjs/core',
      '@nestjs/jwt',
      '@nestjs/platform-express',
      '@nestjs/schedule',
      '@nestjs/schematics',
      '@nestjs/swagger',
      '@nestjs/terminus',
      '@nestjs/testing',
      '@node-rs/argon2',
      '@opentelemetry/api',
      '@opentelemetry/exporter-trace-otlp-http',
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-ioredis',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/resources',
      '@opentelemetry/sdk-node',
      '@opentelemetry/semantic-conventions',
      '@types/cookie-parser',
      '@types/express',
      '@types/jest',
      '@types/node',
      '@types/pg',
      '@types/supertest',
      'ajv',
      'ajv-formats',
      'class-transformer',
      'class-validator',
      'cookie-parser',
      'dotenv',
      'helmet',
      'ioredis',
      'jest',
      'kafkajs',
      'nestjs-pino',
      'pg',
      'pino',
      'pino-http',
      'pino-pretty',
      'prom-client',
      'reflect-metadata',
      'rxjs',
      'supertest',
      'ts-jest',
      'tsx',
      'typescript',
      'uuidv7',
      'zod',
    ]);
    expect(declared('packages/db')).toEqual([
      '@acc/contracts',
      '@types/jest',
      '@types/node',
      '@types/pg',
      'dotenv',
      'drizzle-kit',
      'drizzle-orm',
      'jest',
      'pg',
      'ts-jest',
      'tsx',
      'typescript',
      'uuidv7',
    ]);
    expect(declared('packages/contracts')).toEqual(['typescript']);
  });
});
