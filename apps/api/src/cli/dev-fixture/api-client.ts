/**
 * A minimal client for the real HTTP API.
 *
 * It carries only what any console or integration would: a bearer token from
 * `POST /auth/login`, the `X-Acc-Organization` selection, and a correlation id.
 * It has no privileged header, no test hook and no alternative credential; the
 * API authenticates and authorizes every call exactly as it would anyone's.
 */
import { randomUUID } from 'node:crypto';

import { FIXTURE_USER_AGENT } from './topology';

export class FixtureApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`${method} ${path} answered ${status}${code ? ` ${code}` : ''}`);
    this.name = 'FixtureApiError';
  }
}

export class FixtureApiClient {
  private token: string | null = null;
  /** One correlation id per run, so every audit row the run causes can be found together. */
  readonly correlationId = randomUUID();

  constructor(private readonly baseUrl: string) {}

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; org?: string; csrf?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = {
      'user-agent': FIXTURE_USER_AGENT,
      'x-correlation-id': this.correlationId,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (options.org) headers['x-acc-organization'] = options.org;
    if (options.csrf) headers['x-acc-refresh'] = '1';
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : {}) as T & { error?: { code?: string } };
    if (!response.ok) {
      // Only the status and error code are surfaced: never a request body.
      throw new FixtureApiError(method, path, response.status, body.error?.code);
    }
    return { status: response.status, body };
  }

  async login(email: string, password: string): Promise<void> {
    const { body } = await this.call<{ data: { accessToken: string } }>('POST', '/auth/login', {
      body: { email, password },
    });
    this.token = body.data.accessToken;
  }

  /** Ends the session this client signed in with. Safe to call when not signed in. */
  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await this.call('POST', '/auth/logout', { csrf: true });
    } finally {
      this.token = null;
    }
  }

  async get<T>(path: string, org?: string): Promise<T> {
    return (await this.call<{ data: T }>('GET', path, { org })).body.data;
  }

  async post<T>(path: string, body: unknown, org?: string): Promise<T> {
    return (await this.call<{ data: T }>('POST', path, { body, org })).body.data;
  }
}
