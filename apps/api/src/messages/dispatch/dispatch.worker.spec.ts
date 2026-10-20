import type { AppConfigService } from '../../config/app-config.service';
import { DispatchWorker, POLL_JITTER } from './dispatch.worker';
import type { DispatcherService } from './dispatcher.service';

/** A promise the test settles by hand, to hold a cycle open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeWorker(dispatch: {
  workerEnabled: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
}) {
  const calls: string[] = [];
  const dispatcher = {
    recoverExpiredLeases: jest.fn(async () => {
      calls.push('recover');
      return 0;
    }),
    dispatchBatch: jest.fn(async (limit: number) => {
      calls.push(`dispatch:${limit}`);
      return [];
    }),
  };
  const config = {
    dispatch: { pollIntervalMs: 1_000, batchSize: 10, ...dispatch },
  } as unknown as AppConfigService;
  const worker = new DispatchWorker(config, dispatcher as unknown as DispatcherService);
  return { worker, dispatcher, calls };
}

/** Lets the cycle's promise chain run to completion under fake timers. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('DispatchWorker (ADR-014 D18)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('disabled: never schedules and never touches the dispatcher', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: false });
    worker.onApplicationBootstrap();

    expect(worker.isRunning()).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(dispatcher.recoverExpiredLeases).not.toHaveBeenCalled();
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });

  it('enabled: each cycle recovers expired leases first, then dispatches one batch of the configured size', async () => {
    const { worker, calls } = makeWorker({ workerEnabled: true, batchSize: 7 });
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: exactly the interval
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(true);

    await jest.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(calls).toEqual(['recover', 'dispatch:7']);

    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(calls).toEqual(['recover', 'dispatch:7', 'recover', 'dispatch:7']);
    await worker.onModuleDestroy();
  });

  it.each([
    [0, 1_000 * (1 - POLL_JITTER)],
    [0.999999, 1_000 * (1 + POLL_JITTER)],
  ])('jitter stays within ±20 %% of the interval (random=%p → %p ms)', async (random, delayMs) => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    jest.spyOn(Math, 'random').mockReturnValue(random);
    worker.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(Math.floor(delayMs) - 2);
    expect(dispatcher.recoverExpiredLeases).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(4);
    expect(dispatcher.recoverExpiredLeases).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });

  it('cycles never overlap: the next poll is scheduled only after the running cycle finishes', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const held = deferred<never[]>();
    dispatcher.dispatchBatch.mockImplementationOnce(() => held.promise);
    worker.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);

    held.resolve([]);
    await flush();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(2);
    await worker.onModuleDestroy();
  });

  it('a failed cycle is logged and the loop carries on', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const logged = jest
      .spyOn((worker as unknown as { logger: { error: (m: unknown) => void } }).logger, 'error')
      .mockImplementation(() => undefined);
    dispatcher.recoverExpiredLeases.mockRejectedValueOnce(new Error('connection refused'));
    worker.onApplicationBootstrap();

    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ error: 'connection refused' }));
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });

  it('shutdown waits for the cycle in progress, then schedules nothing more', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const held = deferred<never[]>();
    dispatcher.dispatchBatch.mockImplementationOnce(() => held.promise);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1_000);

    let closed = false;
    const closing = worker.onModuleDestroy().then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);

    held.resolve([]);
    await closing;
    expect(closed).toBe(true);
    expect(worker.isRunning()).toBe(false);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(dispatcher.recoverExpiredLeases).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchBatch).toHaveBeenCalledTimes(1);
  });

  it('shutdown during lease recovery skips claiming new work', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const held = deferred<number>();
    dispatcher.recoverExpiredLeases.mockImplementationOnce(() => held.promise);
    worker.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1_000);

    const closing = worker.onModuleDestroy();
    held.resolve(0);
    await closing;
    expect(dispatcher.dispatchBatch).not.toHaveBeenCalled();
  });

  it('shutdown before the first poll cancels it', async () => {
    const { worker, dispatcher } = makeWorker({ workerEnabled: true });
    worker.onApplicationBootstrap();
    await worker.onModuleDestroy();

    expect(worker.isRunning()).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(dispatcher.recoverExpiredLeases).not.toHaveBeenCalled();
  });
});
