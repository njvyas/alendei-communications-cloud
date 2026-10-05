/**
 * A minimal client for the real HTTP API, as the provider-console fixture's
 * platform administrator. Like the Phase 1C.4a client it carries only what any
 * console would — a bearer token from `POST /auth/login` and a correlation id —
 * with no privileged header or test hook; it adds `PUT` for the capability set.
 */
import { randomUUID } from 'node:crypto';

import { PROVIDER_FIXTURE_USER_AGENT } from './topology';

export class ProviderFixtureApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${method} ${path} answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ProviderFixtureApiError';
  }
}

export class ProviderFixtureApiClient {
  private token: string | null = null;
  readonly correlationId = randomUUID();

  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    csrf = false,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'user-agent': PROVIDER_FIXTURE_USER_AGENT,
      'x-correlation-id': this.correlationId,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (csrf) headers['x-acc-refresh'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : {}) as { data: T; error?: { code?: string } };
    if (!response.ok) {
      // Only the status and error code are surfaced: never a request body.
      throw new ProviderFixtureApiError(method, path, response.status, parsed.error?.code);
    }
    return parsed.data;
  }

  async login(email: string, password: string): Promise<void> {
    const data = await this.call<{ accessToken: string }>('POST', '/auth/login', {
      email,
      password,
    });
    this.token = data.accessToken;
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call('POST', '/auth/logout', undefined, true);
    } finally {
      this.token = null;
    }
  }

  get<T>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.call<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>('PUT', path, body);
  }
}
