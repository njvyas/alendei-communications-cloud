import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Deterministic form of an OpenAPI document (Phase 1C.3 ADR): the served
 * document, the committed snapshot and the CI check all pass through this, so
 * a refactor that only reorders registration never shows up as drift.
 *
 * - every object's keys are sorted (paths, methods and schemas included);
 * - `parameters` are sorted by (`in`, `name`) and `required` arrays
 *   alphabetically, since neither order carries meaning;
 * - the order of `security` requirement objects is sorted by their scheme
 *   names (alternatives, so order carries no meaning);
 * - every other array keeps its order — `enum`, `allOf`/`oneOf`, `tags` on an
 *   operation — because there the order is either meaningful or authored.
 */
export function normalizeOpenApiDocument<T extends OpenAPIObject>(document: T): T {
  return normalize(document, []) as T;
}

/** The canonical serialization: two-space JSON with a trailing newline. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(normalizeOpenApiDocument(document), null, 2)}\n`;
}

function normalize(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item, index) => normalize(item, [...path, String(index)]));
    const key = path[path.length - 1];
    if (key === 'parameters') {
      return [...items].sort((a, b) => parameterKey(a).localeCompare(parameterKey(b)));
    }
    if (key === 'required' && items.every((item) => typeof item === 'string')) {
      return [...(items as string[])].sort();
    }
    if (key === 'security' || (key === 'tags' && path.length === 1)) {
      return [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = normalize(child, [...path, key]);
    }
    return out;
  }
  return value;
}

function parameterKey(parameter: unknown): string {
  const p = parameter as { in?: string; name?: string; $ref?: string };
  return p.$ref ?? `${p.in ?? ''}:${p.name ?? ''}`;
}
