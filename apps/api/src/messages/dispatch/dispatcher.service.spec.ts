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
