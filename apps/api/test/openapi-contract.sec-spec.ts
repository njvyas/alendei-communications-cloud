/**
 * Phase 1C.3 — the OpenAPI document reconciled with the running application.
 *
 * The document is taken from the module graph the real bootstrap builds
 * (`createApp()` under `APP_ENV=test`, `OPENAPI_UI_ENABLED=true`) and checked
 * against that graph's own route metadata — never against itself:
 *
 *   A  the served document equals the committed snapshot (the ts-jest path and
 *      the `tsc`/CLI path agree), and the committed plugin metadata is loaded
 *   B  routes ↔ operations in both directions; exactly one exclusion
 *   C  every operation's security from `@AcceptedCredentials`, consistent with
 *      `@Public`; posture-derived error responses
 *   D  headers: `X-Acc-Organization`, `X-Acc-Refresh`, `Idempotency-Key`
 *   E  every request DTO's schema matches its class-validator rules
 *   F  internal consistency: unique operation ids, resolvable refs, error codes
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ERROR_CODES } from '@acc/contracts';

import { bootAppInFileRegistry, type Booted } from './openapi-support';

type Json = Record<string, unknown>;

// Not imported from `auth-harness`: that module loads `AppModule` at import
// time, before this suite turns the OpenAPI capability on.
const PREFIX = 'api/v1';
const SNAPSHOT = resolve(__dirname, '../openapi/openapi.v1.json');
const NEST_CLI = resolve(__dirname, '../nest-cli.json');
const UNPREFIXED = ['metrics', 'health', 'health/live', 'health/ready'];
const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
/** RouteParamtypes (`@nestjs/common`): BODY, QUERY, PARAM. */
const BODY = 3;
const QUERY = 4;

/** The one approved exclusion (ADR, "Route exclusions"). */
const EXCLUDED = [{ method: 'GET', path: '/metrics', controller: 'MetricsController' }];

interface Route {
  readonly method: string;
  readonly path: string;
  readonly controller: new (...args: never[]) => unknown;
  readonly name: string;
  readonly handler: (...args: never[]) => unknown;
  readonly operationId: string;
}

describe('Phase 1C.3 — OpenAPI contract reconciliation', () => {
  let booted: Booted;
  let document: Json;
  let routes: Route[];

  const meta = <T>(key: string, route: Route): T | undefined =>
    (Reflect.getMetadata(key, route.handler) as T | undefined) ??
    (Reflect.getMetadata(key, route.controller) as T | undefined);
  const paths = () => document.paths as Record<string, Record<string, Json>>;
  const operationOf = (route: Route): Json | undefined =>
    paths()[route.path]?.[route.method.toLowerCase()];
  const documented = () => routes.filter((r) => !isExcluded(r));
  const isExcluded = (r: Route) => EXCLUDED.some((e) => e.method === r.method && e.path === r.path);

  beforeAll(async () => {
    booted = await bootAppInFileRegistry({ APP_ENV: 'test', OPENAPI_UI_ENABLED: 'true' });
    const service = booted.resolve<{ get(): Promise<Json> }>(
      '../src/openapi/openapi-document.service',
      'OpenApiDocumentService',
    );
    document = await service.get();
    routes = discoverRoutes(booted);
  }, 120_000);

  afterAll(async () => {
    await booted?.close();
  });

  function discoverRoutes(target: Booted): Route[] {
    const app = target.app as unknown as {
      container: {
        getModules(): Map<string, { controllers: Map<unknown, { metatype: unknown }> }>;
      };
      config: { getGlobalPrefix(): string };
    };
    const { operationIdFor } = target.load<{
      operationIdFor(controller: string, method: string): string;
    }>('../src/openapi/openapi-document');
    const prefix = app.config.getGlobalPrefix();
    const found: Route[] = [];
    for (const module of app.container.getModules().values()) {
      for (const wrapper of module.controllers.values()) {
        const controller = wrapper.metatype as Route['controller'] | null;
        if (!controller) continue;
        const base = String(Reflect.getMetadata('path', controller) ?? '');
        for (const name of Object.getOwnPropertyNames(controller.prototype)) {
          const handler = (controller.prototype as Record<string, unknown>)[name];
          if (name === 'constructor' || typeof handler !== 'function') continue;
          const method = Reflect.getMetadata('method', handler) as number | undefined;
          const sub = Reflect.getMetadata('path', handler) as string | undefined;
          if (method === undefined || sub === undefined) continue;
          const joined = [base, sub]
            .map((s) => s.replace(/^\/+|\/+$/g, ''))
            .filter((s) => s.length > 0)
            .join('/');
          const full = UNPREFIXED.includes(joined) ? `/${joined}` : `/${prefix}/${joined}`;
          found.push({
            method: REQUEST_METHODS[method]!,
            path: full.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
            controller,
            name,
            handler: handler as Route['handler'],
            operationId: operationIdFor(controller.name, name),
          });
        }
      }
    }
    return found;
  }

  // ===========================================================================
  describe('A. snapshot and metadata', () => {
    it('the served document, normalized, is byte-identical to the committed snapshot', () => {
      const { serializeOpenApiDocument } = booted.load<{
        serializeOpenApiDocument(d: Json): string;
      }>('../src/openapi/openapi-normalize');
      expect(serializeOpenApiDocument(document)).toBe(readFileSync(SNAPSHOT, 'utf8'));
    });

    it('the Swagger CLI plugin is not part of the build; the committed metadata is what is loaded', () => {
      const cli = JSON.parse(readFileSync(NEST_CLI, 'utf8')) as Json;
      expect(JSON.stringify(cli)).not.toContain('@nestjs/swagger');
      const schemas = (document.components as Json).schemas as Record<string, Json>;
      // Plugin-derived: present only because src/metadata.ts was loaded.
      expect(Object.keys((schemas.CreateOrganizationDto!.properties as Json) ?? {})).toEqual(
        expect.arrayContaining(['name', 'slug', 'resellerId']),
      );
      expect(document.openapi).toBe('3.0.3');
    });
  });

  // ===========================================================================
  describe('B. routes and operations', () => {
    /**
     * The reconciliation, stated exactly. "Routes" are the controller handlers
     * in the module graph this configuration (test + flag) builds — one per
     * method and path; no middleware, no framework route:
     *
     *   74 application operations (including the three health routes; Phase
     *      2.1 added the ten provider/channel catalogue operations, Phase 2.2
     *      the provider test-send, Phase 2.3 the provider health check, the
     *      health override and the health-sample list, and its Gate D.3
     *      remediation the circuit-policy read and replace)
     * +  1 OpenAPI document operation (`GET /api/v1/openapi.json`)
     * = 75 documented operations
     * +  1 intentional exclusion (`GET /metrics`, the only one)
     * = 76 handler routes
     *
     * A route added or removed on purpose changes these numbers here, in the
     * same change; the two tests below fail on any route or operation that
     * exists on only one side.
     */
    const APPLICATION_OPERATIONS = 74;
    const DOCUMENT_OPERATION = `GET /${PREFIX}/openapi.json`;
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

    it('reconciles exactly: 74 application operations + 1 document operation = 75; GET /metrics the sole exclusion', () => {
      const all = routes.map(key);
      expect(new Set(all).size).toBe(all.length);
      const excluded = routes.filter(isExcluded).map(key);
      const document = routes.filter((r) => key(r) === DOCUMENT_OPERATION).map(key);
      const application = routes
        .filter((r) => !isExcluded(r) && key(r) !== DOCUMENT_OPERATION)
        .map(key);
      expect(excluded).toEqual(['GET /metrics']);
      expect(document).toEqual([DOCUMENT_OPERATION]);
      expect(application).toHaveLength(APPLICATION_OPERATIONS);
      expect(routes).toHaveLength(APPLICATION_OPERATIONS + 1 + 1);

      const operations = Object.entries(paths()).flatMap(([path, item]) =>
        Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
      );
      expect(operations).toHaveLength(APPLICATION_OPERATIONS + 1);
      expect([...operations].sort()).toEqual([...application, ...document].sort());
    });

    it('the Express route table holds exactly the discovered handlers — no route outside the controller graph', () => {
      // Single-handler route layers are controller routes; Nest mounts
      // middleware (correlation, the canonical-path check) as route layers
      // carrying every method, which are not operations.
      const http = booted.app.getHttpAdapter().getInstance() as {
        router: {
          stack: Array<{
            route?: { path: string; methods: Record<string, boolean>; stack: unknown[] };
          }>;
        };
      };
      const mounted = http.router.stack
        .flatMap((layer) => {
          const route = layer.route;
          const methods = route ? Object.keys(route.methods).filter((m) => m !== '_all') : [];
          return route && route.stack.length === 1 && methods.length === 1
            ? [`${methods[0]!.toUpperCase()} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`]
            : [];
        })
        .sort();
      expect(mounted).toEqual(routes.map(key).sort());
    });

    it('every route is documented, except exactly the approved exclusion', () => {
      const missing = documented()
        .filter((r) => !operationOf(r))
        .map((r) => `${r.method} ${r.path}`);
      expect(missing).toEqual([]);
      for (const e of EXCLUDED) {
        const route = routes.find((r) => r.method === e.method && r.path === e.path);
        expect(route?.controller.name).toBe(e.controller);
        expect(paths()[e.path]).toBeUndefined();
      }
    });

    it('every documented operation is a real route — nothing is documented that does not exist', () => {
      const real = new Set(routes.map((r) => `${r.method} ${r.path}`));
      const phantom: string[] = [];
      for (const [path, item] of Object.entries(paths())) {
        for (const method of Object.keys(item)) {
          if (!real.has(`${method.toUpperCase()} ${path}`)) phantom.push(`${method} ${path}`);
        }
      }
      expect(phantom).toEqual([]);
    });

    it('no route can disappear silently: the only exclusion metadata is the approved one', () => {
      const excludedControllers = routes
        .filter((r) => Reflect.getMetadata('swagger/apiExcludeController', r.controller))
        .map((r) => r.controller.name);
      expect([...new Set(excludedControllers)]).toEqual(['MetricsController']);
      const excludedEndpoints = routes.filter((r) =>
        Reflect.getMetadata('swagger/apiExcludeEndpoint', r.handler),
      );
      expect(excludedEndpoints).toEqual([]);
    });

    it('each operation id is its handler’s, and unique', () => {
      const ids = documented().map((r) => operationOf(r)?.operationId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const route of documented()) {
        expect(`${route.method} ${route.path}: ${String(operationOf(route)!.operationId)}`).toBe(
          `${route.method} ${route.path}: ${route.operationId}`,
        );
      }
    });
  });

  // ===========================================================================
  describe('C. security and posture', () => {
    it('every documented operation declares its credentials, consistent with @Public', () => {
      const problems: string[] = [];
      for (const route of documented()) {
        const credentials = meta<string[]>('acc:openapi:accepted-credentials', route);
        const isPublic = meta<boolean>('acc:auth:public', route) === true;
        const label = `${route.method} ${route.path}`;
        if (!credentials) {
          problems.push(`${label}: no @AcceptedCredentials`);
          continue;
        }
        // `@Public` means no bearer credential: such a route accepts nothing, or
        // only the refresh cookie (`POST /auth/refresh`). A route that accepts
        // nothing must be `@Public`.
        const bearerless = credentials.every((c) => c === 'none' || c === 'refreshCookie');
        if (isPublic !== bearerless || (credentials.includes('none') && !isPublic)) {
          problems.push(`${label}: credentials ${credentials} vs @Public ${isPublic}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('each operation’s OpenAPI security is exactly its declared credentials', () => {
      const problems: string[] = [];
      for (const route of documented()) {
        const credentials = (
          meta<string[]>('acc:openapi:accepted-credentials', route) ?? []
        ).filter((c) => c !== 'none');
        const security = ((operationOf(route)!.security as Json[] | undefined) ?? [])
          .map((s) => Object.keys(s))
          .flat()
          .sort();
        if (JSON.stringify(security) !== JSON.stringify([...credentials].sort())) {
          problems.push(`${route.method} ${route.path}: security ${security} vs ${credentials}`);
        }
      }
      expect(problems).toEqual([]);
      const schemes = Object.keys(
        (document.components as Json).securitySchemes as Record<string, unknown>,
      ).sort();
      expect(schemes).toEqual(['apiKey', 'refreshCookie', 'userSession']);
    });

    it('the security schemes describe the real wire protocol', () => {
      const schemes = (document.components as Json).securitySchemes as Record<string, Json>;
      expect(schemes.userSession).toMatchObject({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      // An API key is a bearer credential, not an OpenAPI `apiKey` header scheme.
      expect(schemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
      expect(String(schemes.apiKey!.bearerFormat)).toMatch(/^ak_/);
      expect(schemes.refreshCookie).toMatchObject({
        type: 'apiKey',
        in: 'cookie',
        name: 'acc_refresh',
      });
    });

    it('error responses follow each route’s posture', () => {
      const problems: string[] = [];
      for (const route of documented()) {
        const op = operationOf(route)!;
        const codes = Object.keys(op.responses as Json);
        const need = (code: string, why: string) => {
          if (!codes.includes(code))
            problems.push(`${route.method} ${route.path}: no ${code} (${why})`);
        };
        const credentials = meta<string[]>('acc:openapi:accepted-credentials', route) ?? [];
        const isPublic = credentials.includes('none');
        const params = ((op.parameters as Json[] | undefined) ?? []).filter((p) => !p.$ref);
        if (!isPublic) {
          need('401', 'authenticated');
          need('429', 'rate-limited');
        }
        if (params.some((p) => p.in === 'path')) {
          need('400', 'path parameter validation');
          need('404', 'addresses a resource by id');
        }
        if (op.requestBody || params.some((p) => p.in === 'query')) need('400', 'validated input');
        if (meta('acc:authz:requires-permission', route)) need('403', 'permission-checked');
        if (meta<boolean>('acc:auth:require-csrf', route)) need('403', 'X-Acc-Refresh');
        if (meta<boolean>('acc:auth:require-json', route)) need('415', 'JSON body required');
        const success = codes.filter((c) => c.startsWith('2'));
        if (success.length !== 1)
          problems.push(`${route.method} ${route.path}: success ${success}`);
      }
      expect(problems).toEqual([]);
    });
  });

  // ===========================================================================
  describe('D. headers', () => {
    const refs = (op: Json) =>
      ((op.parameters as Json[] | undefined) ?? []).map(
        (p) =>
          (p.$ref as string | undefined)?.replace('#/components/parameters/', '') ??
          `${p.in}:${p.name}`,
      );

    it('X-Acc-Organization exactly where an organization is resolved; X-Acc-Refresh exactly where it is enforced', () => {
      const problems: string[] = [];
      for (const route of documented()) {
        const op = operationOf(route)!;
        const has = refs(op);
        const isPublic = meta<boolean>('acc:auth:public', route) === true;
        const noTenant = meta<boolean>('acc:auth:skip-tenant', route) === true;
        const csrf = meta<boolean>('acc:auth:require-csrf', route) === true;
        const label = `${route.method} ${route.path}`;
        if (has.includes('X-Acc-Organization') !== (!isPublic && !noTenant)) {
          problems.push(`${label}: X-Acc-Organization`);
        }
        if (has.includes('X-Acc-Refresh') !== csrf) problems.push(`${label}: X-Acc-Refresh`);
        for (const always of ['X-Correlation-Id', 'X-Causation-Id']) {
          if (!has.includes(always)) problems.push(`${label}: ${always}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('Idempotency-Key exactly on the handlers that read it', () => {
      const problems: string[] = [];
      for (const route of documented()) {
        const args = (Reflect.getMetadata('__routeArguments__', route.controller, route.name) ??
          {}) as Record<string, { factory?: (...a: unknown[]) => unknown }>;
        const reads = Object.values(args).some((a) =>
          String(a.factory ?? '').includes('IDEMPOTENCY_HEADER'),
        );
        const documentedHeader = refs(operationOf(route)!).includes('header:Idempotency-Key');
        if (reads !== documentedHeader) {
          problems.push(
            `${route.method} ${route.path}: reads ${reads}, documented ${documentedHeader}`,
          );
        }
      }
      expect(problems).toEqual([]);
      expect(
        documented().filter((r) => refs(operationOf(r)!).includes('header:Idempotency-Key')).length,
      ).toBe(7);
    });
  });

  // ===========================================================================
  describe('E. request DTOs match their validation rules', () => {
    interface Rule {
      type: string;
      name?: string | null;
      each?: boolean | null;
      constraints: unknown[];
      propertyName: string;
    }

    function expected(dto: new () => unknown): Map<string, Json> {
      const cv = booted.load<{
        getMetadataStorage(): {
          getTargetValidationMetadatas(t: unknown, s: string, a: boolean, g: boolean): Rule[];
        };
      }>('class-validator');
      const rules = cv.getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false);
      const out = new Map<string, Json>();
      for (const rule of rules) {
        const e = out.get(rule.propertyName) ?? { required: true };
        out.set(rule.propertyName, e);
        const target = rule.each ? ((e.items as Json) ??= {}) : e;
        const [c0] = rule.constraints ?? [];
        switch (rule.type === 'customValidation' ? rule.name : rule.type) {
          case 'conditionalValidation':
            if (rule.name === 'isOptional') e.required = false;
            else e.nullable = true; // ValidateIf(value !== null): null admitted
            break;
          case 'nestedValidation':
            e.nested = true;
            break;
          case 'whitelistValidation':
            // `@Allow()`: any value, including none.
            e.required = false;
            break;
          case 'isString':
            target.type = 'string';
            break;
          case 'isBoolean':
            target.type = 'boolean';
            break;
          case 'isInt':
            target.type = 'integer';
            break;
          case 'isObject':
            target.type = 'object';
            break;
          case 'isArray':
            e.type = 'array';
            break;
          case 'isEmail':
            target.type = 'string';
            target.format = 'email';
            break;
          case 'isUuid':
            target.format = 'uuid';
            break;
          case 'isDate':
            target.format = 'date-time';
            break;
          case 'maxLength':
            target.maxLength = c0;
            break;
          case 'minLength':
            target.minLength = c0;
            break;
          case 'min':
            target.minimum = c0;
            break;
          case 'max':
            target.maximum = c0;
            break;
          case 'arrayMinSize':
            e.minItems = c0;
            break;
          case 'arrayMaxSize':
            e.maxItems = c0;
            break;
          case 'arrayUnique':
            e.uniqueItems = true;
            break;
          case 'isIn':
            target.enum = [...(c0 as unknown[])].sort();
            break;
          case 'matches':
            target.pattern = (c0 as RegExp).source;
            break;
          default:
            throw new Error(
              `${dto.name}.${rule.propertyName}: unmapped validator ${rule.type}/${rule.name}`,
            );
        }
      }
      return out;
    }

    function compare(
      label: string,
      ruleIn: Json,
      schema: Json | undefined,
      required: boolean,
      problems: string[],
    ) {
      let rule = ruleIn;
      if (!schema) {
        problems.push(`${label}: not in the schema`);
        return;
      }
      const resolved = (schema.allOf as Json[] | undefined)?.[0] ?? schema;
      // A nested DTO is a `$ref` to its own (separately checked) schema.
      if (rule.nested && resolved.$ref) rule = { ...rule, type: undefined };
      if (rule.required !== required)
        problems.push(`${label}: required ${required}, rule ${String(rule.required)}`);
      for (const key of [
        'type',
        'format',
        'maxLength',
        'minLength',
        'minimum',
        'maximum',
        'pattern',
        'minItems',
        'maxItems',
        'uniqueItems',
        'nullable',
      ]) {
        if (rule[key] !== undefined && resolved[key] !== rule[key]) {
          problems.push(
            `${label}: ${key} ${JSON.stringify(resolved[key])} ≠ rule ${JSON.stringify(rule[key])}`,
          );
        }
      }
      if (rule.enum !== undefined) {
        const got = [...((resolved.enum as unknown[]) ?? [])].sort();
        // OpenAPI 3.0: a nullable enum admits null only if null is one of its
        // values (Phase 2.3, the first nullable enum), so a DTO that admits
        // null must document it there too.
        const want = rule.nullable ? [...(rule.enum as unknown[]), null].sort() : rule.enum;
        if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${label}: enum differs`);
      }
      if (rule.items)
        compare(
          `${label}[]`,
          { required, ...(rule.items as Json) },
          resolved.items as Json,
          required,
          problems,
        );
    }

    it('every body and query DTO is documented exactly as it validates', () => {
      const problems: string[] = [];
      const schemas = (document.components as Json).schemas as Record<string, Json>;
      let checked = 0;
      for (const route of documented()) {
        const types = (Reflect.getMetadata(
          'design:paramtypes',
          route.controller.prototype,
          route.name,
        ) ?? []) as Array<new () => unknown>;
        const args = (Reflect.getMetadata('__routeArguments__', route.controller, route.name) ??
          {}) as Record<string, { index: number }>;
        const op = operationOf(route)!;
        for (const [key, arg] of Object.entries(args)) {
          const kind = Number(key.split(':')[0]);
          if (kind !== BODY && kind !== QUERY) continue;
          const dto = types[arg.index];
          if (!dto || !dto.name.endsWith('Dto')) continue;
          checked += 1;
          const rules = expected(dto);
          if (kind === BODY) {
            const ref = (((op.requestBody as Json)?.content as Json)?.['application/json'] as Json)
              ?.schema as Json;
            const schema = schemas[String(ref?.$ref ?? '').replace('#/components/schemas/', '')];
            if (!schema) {
              problems.push(`${route.method} ${route.path}: body ${dto.name} not documented`);
              continue;
            }
            if (schema.additionalProperties !== false) problems.push(`${dto.name}: not closed`);
            const props = (schema.properties ?? {}) as Record<string, Json>;
            const required = (schema.required as string[] | undefined) ?? [];
            for (const [name, rule] of rules)
              compare(`${dto.name}.${name}`, rule, props[name], required.includes(name), problems);
            for (const name of Object.keys(props))
              if (!rules.has(name))
                problems.push(`${dto.name}.${name}: documented but not validated`);
          } else {
            const params = ((op.parameters as Json[] | undefined) ?? []).filter(
              (p) => p.in === 'query',
            );
            for (const [name, rule] of rules) {
              const param = params.find((p) => p.name === name);
              compare(
                `${dto.name}?${name}`,
                rule,
                param?.schema as Json | undefined,
                param?.required === true,
                problems,
              );
            }
            for (const param of params)
              if (!rules.has(String(param.name)))
                problems.push(`${dto.name}?${String(param.name)}: documented but not validated`);
          }
        }
      }
      expect(checked).toBeGreaterThanOrEqual(25);
      expect(problems).toEqual([]);
    });
  });

  // ===========================================================================
  describe('F. internal consistency', () => {
    it('every $ref resolves', () => {
      const dangling: string[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value && typeof value === 'object') {
          for (const [k, v] of Object.entries(value as Json)) {
            if (k === '$ref' && typeof v === 'string') {
              const [, section, name] = v.split('/').slice(1);
              if (!((document.components as Json)[section!] as Json | undefined)?.[name!])
                dangling.push(v);
            } else walk(v);
          }
        }
      };
      walk(document);
      expect(dangling).toEqual([]);
    });

    it('the error envelope names every error code the API can return', () => {
      const body = ((document.components as Json).schemas as Record<string, Json>).ErrorBody!;
      const code = (body.properties as Record<string, Json>).code!;
      expect([...(code.enum as string[])].sort()).toEqual([...Object.values(ERROR_CODES)].sort());
    });
  });
});
