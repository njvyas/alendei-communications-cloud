/**
 * Opt-in OpenAPI response validation for the Phase 1C.3 contract suites
 * (ADR G6, G10). Nothing else uses it; it changes no existing test.
 *
 * Given the served document, it finds the operation a request hit, and checks
 * that the response status is documented, that the body validates against the
 * documented schema (closed objects, so an undocumented field fails), and that
 * every header the document marks `required` is present.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { Response } from 'supertest';

type Json = Record<string, unknown>;

export interface OperationRef {
  readonly method: string;
  readonly template: string;
  readonly operation: Json;
}

export class OpenApiValidator {
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction>();
  private readonly matchers: Array<{ method: string; template: string; pattern: RegExp }> = [];

  constructor(readonly document: Json) {
    // OpenAPI 3.0 Schema Objects are a JSON Schema dialect: `nullable` is
    // understood by Ajv, and annotation keywords (`example`, `deprecated`) are
    // allowed rather than rejected.
    this.ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(this.ajv);
    this.ajv.addSchema({ $id: 'openapi', components: (document.components ?? {}) as Json });
    const paths = document.paths as Record<string, Record<string, Json>>;
    for (const [template, item] of Object.entries(paths)) {
      const pattern = new RegExp(
        `^${template.replace(/[.]/g, '\\.').replace(/\{[^}]+\}/g, '[^/]+')}$`,
      );
      for (const method of Object.keys(item)) {
        this.matchers.push({ method: method.toUpperCase(), template, pattern });
      }
    }
  }

  /** The documented operation for a concrete request path, or undefined. */
  find(method: string, path: string): OperationRef | undefined {
    const bare = path.split('?')[0]!;
    const hit = this.matchers.find(
      (m) => m.method === method.toUpperCase() && m.pattern.test(bare),
    );
    if (!hit) return undefined;
    const paths = this.document.paths as Record<string, Record<string, Json>>;
    return {
      method: hit.method,
      template: hit.template,
      operation: paths[hit.template]![hit.method.toLowerCase()]!,
    };
  }

  /**
   * Validates one response. Returns the problems found (empty when the
   * response conforms), so a caller can report every problem at once.
   */
  check(method: string, path: string, res: Response): string[] {
    const ref = this.find(method, path);
    if (!ref) return [`${method} ${path}: no documented operation`];
    const label = `${ref.method} ${ref.template} → ${res.status}`;
    const responses = ref.operation.responses as Record<string, Json>;
    const documented = responses[String(res.status)];
    if (!documented) {
      return [`${label}: status not documented (documented: ${Object.keys(responses).join(', ')})`];
    }
    const problems: string[] = [];

    const content = documented.content as Record<string, { schema?: Json }> | undefined;
    const schema = content?.['application/json']?.schema;
    if (schema) {
      if (!/^application\/json/.test(String(res.headers['content-type'] ?? ''))) {
        problems.push(`${label}: expected a JSON body, got ${String(res.headers['content-type'])}`);
      } else {
        const validate = this.compile(schema);
        if (!validate(res.body)) {
          problems.push(`${label}: body does not match — ${this.ajv.errorsText(validate.errors)}`);
        }
      }
    } else if (res.status !== 204 && res.text && res.text.length > 0) {
      problems.push(`${label}: a body was returned but none is documented`);
    }
    if (res.status === 204 && res.text) problems.push(`${label}: 204 carried a body`);

    for (const [name, raw] of Object.entries((documented.headers ?? {}) as Record<string, Json>)) {
      const headerObject = this.resolveHeader(raw);
      if (headerObject.required === true && res.headers[name.toLowerCase()] === undefined) {
        problems.push(`${label}: required header ${name} is missing`);
      }
    }
    return problems;
  }

  private resolveHeader(raw: Json): Json {
    const ref = raw.$ref as string | undefined;
    if (!ref) return raw;
    const key = ref.replace('#/components/headers/', '');
    return ((this.document.components as Json).headers as Record<string, Json>)[key]!;
  }

  private compile(schema: Json): ValidateFunction {
    const key = JSON.stringify(schema);
    let validate = this.compiled.get(key);
    if (!validate) {
      validate = this.ajv.compile(rebase(schema) as Json);
      this.compiled.set(key, validate);
    }
    return validate;
  }
}

/** Points document-relative `$ref`s at the registered `openapi` schema. */
function rebase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebase);
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      out[k] =
        k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi${v}` : rebase(v);
    }
    return out;
  }
  return value;
}
