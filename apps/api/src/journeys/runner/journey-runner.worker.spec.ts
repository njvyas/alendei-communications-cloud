import { JourneyRunner } from './journey-runner.worker';
import type { JourneyRunnerService } from './journey-runner.service';
import type { AppConfigService } from '../../config/app-config.service';

describe('Phase 8C PR 8C-3 — JourneyRunner (disabled by default)', () => {
  const config = (runnerEnabled: boolean) =>
    ({
      journeys: { runnerEnabled, pollIntervalMs: 50, batchSize: 10 },
    }) as unknown as AppConfigService;
  const service = (available: boolean) => {
    const tick = jest.fn().mockResolvedValue([]);
    return { svc: { available, tick } as unknown as JourneyRunnerService, tick };
  };

  it('does nothing when JOURNEY_RUNNER_ENABLED is false', async () => {
    const { svc, tick } = service(true);
    const worker = new JourneyRunner(config(false), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(tick).not.toHaveBeenCalled();
  });

  it('does nothing when enabled but no acc_journey connection exists', async () => {
    const { svc, tick } = service(false);
    const worker = new JourneyRunner(config(true), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(tick).not.toHaveBeenCalled();
  });

  it('when enabled with a connection, ticks on its poll loop and stops on shutdown', async () => {
    const { svc, tick } = service(true);
    const worker = new JourneyRunner(config(true), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    await worker.onModuleDestroy();
    expect(tick).toHaveBeenCalled();
    expect(worker.isRunning()).toBe(false);
  });
});
