import type { ApiErrorResponse } from '@acc/contracts';

/**
 * Browser-side API client.
 *
 * It never carries a tenant identifier: tenant context is derived server-side
 * from the session (`TENANCY.md` §2), so there is nothing for the console to
 * send and nothing it could usefully forge.
 */
const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    ...rest,
    // Session cookies are the console's credential; a token is never placed in
    // a URL or in local storage.
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw toApiError(response, payload);
  }

  return payload as T;
}

function toApiError(response: Response, payload: unknown): ApiError {
  const envelope = payload as ApiErrorResponse | null;
  const error = envelope?.error;
  return new ApiError(
    response.status,
    error?.code ?? 'INTERNAL_ERROR',
    error?.message ?? 'The request failed',
    error?.correlationId ?? response.headers.get('x-correlation-id') ?? 'unknown',
    error?.retryable ?? false,
    error?.details,
  );
}

/** Health is served outside the versioned prefix (`API.md` §2). */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const root = BASE_URL.replace(/\/api\/v\d+$/, '');
  const response = await fetch(`${root}/health/ready`, { signal, cache: 'no-store' });
  const payload = (await response.json()) as HealthResponse;
  return payload;
}

export interface HealthResponse {
  readonly status: string;
  readonly info?: Record<string, { status: string } & Record<string, unknown>>;
  readonly error?: Record<string, { status: string } & Record<string, unknown>>;
}
