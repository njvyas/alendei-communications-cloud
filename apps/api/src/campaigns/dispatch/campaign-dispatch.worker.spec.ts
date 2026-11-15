import { CampaignDispatchWorker } from './campaign-dispatch.worker';
import type { CampaignDispatchService } from './campaign-dispatch.service';
import type { AppConfigService } from '../../config/app-config.service';

describe('Phase 8B PR 8B-3b — CampaignDispatchWorker (disabled by default)', () => {
  const config = (dispatchEnabled: boolean) =>
    ({
      campaigns: { dispatchEnabled, pollIntervalMs: 50, batchSize: 5 },
    }) as unknown as AppConfigService;
  const service = (available: boolean) => {
    const tick = jest.fn().mockResolvedValue([]);
    return { svc: { available, tick } as unknown as CampaignDispatchService, tick };
  };

  it('does nothing when CAMPAIGN_DISPATCH_ENABLED is false', async () => {
    const { svc, tick } = service(true);
    const worker = new CampaignDispatchWorker(config(false), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(tick).not.toHaveBeenCalled();
  });

  it('does nothing when enabled but no acc_campaign connection exists', async () => {
    const { svc, tick } = service(false);
    const worker = new CampaignDispatchWorker(config(true), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(tick).not.toHaveBeenCalled();
  });

  it('when enabled with a connection, ticks on its poll loop, survives a failed cycle, and stops on shutdown', async () => {
    const { svc, tick } = service(true);
    tick.mockRejectedValueOnce(new Error('transient'));
    const worker = new CampaignDispatchWorker(config(true), svc);
    worker.onApplicationBootstrap();
    expect(worker.isRunning()).toBe(true);
    await new Promise((r) => setTimeout(r, 260));
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    await worker.onModuleDestroy();
    const calls = tick.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(tick.mock.calls.length).toBe(calls);
    expect(worker.isRunning()).toBe(false);
  });
});
