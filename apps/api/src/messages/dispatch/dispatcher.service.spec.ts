import type { Pool, PoolClient } from 'pg';
import type { ProviderSubmissionExecutor } from '../../provider-adapters/submission-executor';
import type { ProviderStateStore } from '../../providers/provider-state.store';
import { DispatcherService, type DispatchClaim } from './dispatcher.service';

/**
 * Issue #22: the dispatcher's three failure paths must log the cause in a
 * structured, safe form (message and SQLSTATE only) and keep their existing
 * rollback, rethrow and return behaviour.
 */

/** A pg-like error carrying fields that must never reach the log. */
function pgError(message: string, code?: unknown): Error {
  return Object.assign(new Error(message), {
    code,
    detail: 'Key (recipient_address)=(+12025550199) already exists.',
    query: 'UPDATE messages SET status = $1 WHERE id = $2',
    parameters: ['submitting', 'secret-message-id'],
  });
}

/** A client whose BEGIN and ROLLBACK succeed and every other query fails with `failure`. */
function makeService(failure: unknown) {
  const queries: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      throw failure;
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client as unknown as PoolClient) };
  const service = new DispatcherService(
    pool as unknown as Pool,
    {} as ProviderStateStore,
    {} as ProviderSubmissionExecutor,
  );
  const logged = jest
    .spyOn((service as unknown as { logger: { error: (m: unknown) => void } }).logger, 'error')
    .mockImplementation(() => undefined);
  return { service, client, queries, logged };
}

const claim: DispatchClaim = {
  messageId: '01955b0a-7b3b-7411-9a4f-9e67d4f9e001',
  orgId: '01955b0a-7b3b-7411-9a4f-9e67d4f91111',
  dispatchEpoch: 1,
  claimToken: 'claim-token-1',
};

describe('DispatcherService failure logging (issue #22)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('claimBatch logs the message and SQLSTATE, rolls back, releases and rethrows', async () => {
    const failure = pgError('permission denied for table message_dispatch_queue', '42501');
    const { service, client, queries, logged } = makeService(failure);

    await expect(service.claimBatch(10)).rejects.toBe(failure);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith({
      msg: 'Failed to claim messages from queue',
      error: 'permission denied for table message_dispatch_queue',
      code: '42501',
    });
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('processClaim logs the cause and still returns outcome unknown with the error string', async () => {
    const failure = pgError('permission denied for function app_has_platform_permission', '42501');
    const { service, client, queries, logged } = makeService(failure);

    await expect(service.processClaim(claim)).resolves.toEqual({
      messageId: claim.messageId,
      attemptId: undefined,
      outcome: 'unknown',
      error: String(failure),
    });

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith({
      msg: 'Failed to process dispatch claim',
      error: 'permission denied for function app_has_platform_permission',
      code: '42501',
    });
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('recoverExpiredLeases logs the message and SQLSTATE, rolls back, releases and rethrows', async () => {
    const failure = pgError('canceling statement due to statement timeout', '57014');
    const { service, client, queries, logged } = makeService(failure);

    await expect(service.recoverExpiredLeases()).rejects.toBe(failure);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith({
      msg: 'Failed to recover expired leases',
      error: 'canceling statement due to statement timeout',
      code: '57014',
    });
    expect(queries[queries.length - 1]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('logs a non-Error thrown value as a string, with no code', async () => {
    const { service, logged } = makeService('connection terminated unexpectedly');

    await expect(service.claimBatch(10)).rejects.toBe('connection terminated unexpectedly');

    expect(logged).toHaveBeenCalledWith({
      msg: 'Failed to claim messages from queue',
      error: 'connection terminated unexpectedly',
    });
  });

  it.each([
    ['absent', undefined],
    ['not a SQLSTATE', 'ECONNRESET'],
    ['wrong length', '4250'],
    ['not a string', 42501],
  ])('omits the code when it is %s', async (_label, code) => {
    const { service, logged } = makeService(pgError('connection refused', code));

    await expect(service.recoverExpiredLeases()).rejects.toThrow('connection refused');

    expect(logged).toHaveBeenCalledWith({
      msg: 'Failed to recover expired leases',
      error: 'connection refused',
    });
  });

  it('never logs the error object, stack, SQL, parameters or detail', async () => {
    const failure = pgError('duplicate key value violates unique constraint', '23505');
    const { service, logged } = makeService(failure);

    await service.processClaim(claim);

    const entry = logged.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['code', 'error', 'msg']);
    const serialized = JSON.stringify(logged.mock.calls);
    for (const leak of ['+12025550199', 'UPDATE messages', 'secret-message-id', 'Error: ']) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe('DispatcherService provider lifecycle exclusion before admission (Issue #20)', () => {
  afterEach(() => jest.restoreAllMocks());

  function makeDispatcherWithCandidates(
    candidates: {
      id: string;
      provider_id: string;
      priority: number;
      provider_status: 'active' | 'disabled' | 'draining';
    }[],
    options?: {
      admitted?: boolean;
    },
  ) {
    const admitMock = jest.fn(async () => ({
      admitted: (options?.admitted ?? true) as true,
      state: 'closed' as const,
      channel: 'whatsapp' as const,
      capabilities: {},
      ticket: 'ticket-1',
      timeoutMs: 5000,
      admission: {} as never,
    }));
    const stateStore = {
      admit: admitMock,
      recordSubmission: jest.fn(),
    } as unknown as ProviderStateStore;

    const executor = {
      execute: jest.fn(async () => ({
        result: { outcome: 'accepted' as const, latencyMs: 50, externalId: 'ext-1' },
      })),
    } as unknown as ProviderSubmissionExecutor;

    const queries: { sql: string; params?: unknown[] }[] = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK')
          return { rows: [], rowCount: 0 };
        if (sql.includes('set_config')) return { rows: [{ set_config: '' }], rowCount: 1 };
        if (sql.includes('FROM message_dispatch_queue')) {
          return {
            rows: [{ claim_token: claim.claimToken, dispatch_epoch: claim.dispatchEpoch }],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT status, current_attempt_id FROM messages')) {
          return { rows: [{ status: 'queued', current_attempt_id: null }], rowCount: 1 };
        }
        if (sql.includes('FROM organizations')) {
          return { rows: [{ status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('FROM messages m')) {
          return {
            rows: [
              {
                id: claim.messageId,
                org_id: claim.orgId,
                channel_id: 'chan-1',
                status: 'queued',
                payload: { text: 'hello' },
                recipient_address: '+12025550199',
                contact_id: 'contact-1',
                channel_code: 'whatsapp',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('app_dispatch_recipient_block'))
          return { rows: [{ block: null }], rowCount: 1 };
        if (sql.includes('FROM organization_provider_assignments opa')) {
          return { rows: candidates, rowCount: candidates.length };
        }
        if (sql.includes('max(attempt_number)')) return { rows: [{ max_num: 0 }], rowCount: 1 };
        if (sql.includes('SELECT count(*)::text AS count FROM message_attempts')) {
          return { rows: [{ count: '0' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: jest.fn(),
    };

    const pool = { connect: jest.fn(async () => client as unknown as PoolClient) };
    const service = new DispatcherService(pool as unknown as Pool, stateStore, executor);

    const warnSpy = jest
      .spyOn((service as unknown as { logger: { warn: (m: unknown) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn((service as unknown as { logger: { error: (m: unknown) => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    return { service, client, stateStore, admitMock, executor, queries, warnSpy, errorSpy };
  }

  it('excludes disabled provider before circuit admission and admits the next active provider', async () => {
    const candidates = [
      { id: 'opa-1', provider_id: 'p-disabled', priority: 1, provider_status: 'disabled' as const },
      { id: 'opa-2', provider_id: 'p-active', priority: 2, provider_status: 'active' as const },
    ];
    const { service, admitMock, warnSpy, errorSpy } = makeDispatcherWithCandidates(candidates);

    const result = await service.processClaim(claim);

    expect(result.outcome).toBe('accepted');
    expect(admitMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p-disabled');
    expect(admitMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p-active');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('not active'),
        providerId: 'p-disabled',
        status: 'disabled',
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('excludes draining provider before circuit admission and admits the next active provider', async () => {
    const candidates = [
      { id: 'opa-1', provider_id: 'p-draining', priority: 1, provider_status: 'draining' as const },
      { id: 'opa-2', provider_id: 'p-active', priority: 2, provider_status: 'active' as const },
    ];
    const { service, admitMock, warnSpy, errorSpy } = makeDispatcherWithCandidates(candidates);

    const result = await service.processClaim(claim);

    expect(result.outcome).toBe('accepted');
    expect(admitMock).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p-draining');
    expect(admitMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'p-active');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.stringContaining('not active'),
        providerId: 'p-draining',
        status: 'draining',
      }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('when all assigned providers are disabled or draining, never calls circuit admission and fails NO_ELIGIBLE_PROVIDER', async () => {
    const candidates = [
      { id: 'opa-1', provider_id: 'p-disabled', priority: 1, provider_status: 'disabled' as const },
      { id: 'opa-2', provider_id: 'p-draining', priority: 2, provider_status: 'draining' as const },
    ];
    const { service, admitMock, queries, warnSpy, errorSpy } =
      makeDispatcherWithCandidates(candidates);

    const result = await service.processClaim(claim);

    expect(result).toEqual({
      messageId: claim.messageId,
      attemptId: undefined,
      outcome: 'circuit_refused',
      error: 'NO_ELIGIBLE_PROVIDER',
    });
    expect(admitMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();

    const eventInsert = queries.find((q) => q.sql.includes('INSERT INTO message_events'));
    expect(eventInsert).toBeDefined();
    const payload = JSON.parse(eventInsert!.params![3] as string);
    expect(payload).toEqual({
      reason: 'NO_ELIGIBLE_PROVIDER',
      details: 'No assigned provider is active (disabled or draining)',
    });
  });
});
