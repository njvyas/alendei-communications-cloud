import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

import type { HeaderObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

import { ErrorEnvelopeSchema, PageInfoSchema } from './openapi-components';

/**
 * Documentation-only response decorators (Phase 1C.3). They describe the
 * envelopes controllers already return; none of them changes a response.
 */

/** `{ data: <model> }` — or `{ data: <model>[] }` without a page. */
export function ApiData(
  model: Type<unknown>,
  options: {
    status?: number;
    description?: string;
    isArray?: boolean;
    headers?: Record<string, HeaderObject>;
  } = {},
) {
  const status = options.status ?? 200;
  const data = options.isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description: options.description ?? defaultDescription(status),
      ...(options.headers ? { headers: options.headers } : {}),
      schema: {
        type: 'object',
        required: ['data'],
        additionalProperties: false,
        properties: { data },
      },
    }),
  );
}

/** `{ data: <model>[], page: PageInfo }` — a cursor-paginated list (`API.md` §8a). */
export function ApiPaged(model: Type<unknown>, options: { description?: string } = {}) {
  return applyDecorators(
    ApiExtraModels(model, PageInfoSchema),
    ApiResponse({
      status: 200,
      description: options.description ?? 'One page of results.',
      schema: {
        type: 'object',
        required: ['data', 'page'],
        additionalProperties: false,
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          page: { $ref: getSchemaPath(PageInfoSchema) },
        },
      },
    }),
  );
}

/** `204 No Content` — no body. */
export function ApiEmpty(description = 'Done; no body.', headers?: Record<string, HeaderObject>) {
  return ApiNoContentResponse({ description, ...(headers ? { headers } : {}) });
}

/** `Set-Cookie` for the refresh cookie (`acc_refresh`, httpOnly, path `/api/v1/auth`). */
export const SETS_REFRESH_COOKIE: Record<string, HeaderObject> = {
  'Set-Cookie': {
    description:
      'Sets `acc_refresh` (httpOnly, SameSite=Lax, `Path=/api/v1/auth`, `Secure` outside development and test).',
    required: true,
    schema: { type: 'string' },
  },
};

/** `Set-Cookie` clearing the refresh cookie. */
export const CLEARS_REFRESH_COOKIE: Record<string, HeaderObject> = {
  'Set-Cookie': {
    description: 'Clears `acc_refresh`.',
    required: true,
    schema: { type: 'string' },
  },
};

const ERROR_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Validation failed (`VALIDATION_FAILED`, `details.issues`), or another request error named by `error.code`.',
  401: 'No valid credential (`AUTH_*`).',
  403: 'Authenticated, but not permitted here (`AUTHZ_*`, `TENANCY_*`).',
  404: 'Not found, or not visible to the caller — indistinguishable by design (`RESOURCE_NOT_FOUND`).',
  415: 'The body must be `application/json` (`VALIDATION_FAILED`).',
  409: 'Conflicts with the current state (named by `error.code`; lifecycle conflicts carry `details.status`).',
  422: 'Well-formed but not admissible here (named by `error.code`).',
  429: 'Rate limit exceeded (`RATE_LIMIT_EXCEEDED`); see `Retry-After`.',
  503: 'A dependency is unavailable (`SERVICE_UNAVAILABLE`).',
};

/** The error envelope (`API.md` §7) for each listed status. */
export function ApiErrors(...statuses: number[]) {
  return applyDecorators(
    ApiExtraModels(ErrorEnvelopeSchema),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? 'Error.',
        schema: { $ref: getSchemaPath(ErrorEnvelopeSchema) },
      }),
    ),
  );
}

/** `Idempotency-Key` (`API.md` §4) — on the creating `POST`s that accept it. */
export function ApiIdempotencyKey() {
  return ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      '16–255 characters of letters, digits, `-`, `_`, `.` or `:` (surrounding whitespace is trimmed; otherwise `400 IDEMPOTENCY_KEY_INVALID`). A repeat with the same key and payload replays the stored response; a different payload is `409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`; a repeat while the first is still running is `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`.',
    schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{16,255}$' },
  });
}

function defaultDescription(status: number): string {
  if (status === 201) return 'Created.';
  return 'OK.';
}
