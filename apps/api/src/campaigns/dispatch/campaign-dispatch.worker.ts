import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { CampaignDispatchService } from './campaign-dispatch.service';

/** ±20 % around the poll interval, so instances started together drift apart. */
export const CAMPAIGN_POLL_JITTER = 0.2;

/**
 * Phase 8B PR 8B-3b: the campaign executor and scheduler loop — a single `setTimeout` chain over
 * the PostgreSQL claim table, as `DispatchWorker` and `JourneyRunner` (no queue library or cron).
 *
 * **Off by default.** It starts only when `CAMPAIGN_DISPATCH_ENABLED` is true — refused outside
 * tests and without billing enforcement (`campaignDispatchProblems`) — AND the `acc_campaign`
 * connection exists. Otherwise it logs that it is disabled and does nothing at all.
 */
@Injectable()
export class CampaignDispatchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CampaignDispatchWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly executor: CampaignDispatchService,
  ) {}

  onApplicationBootstrap(): void {
    const { dispatchEnabled, pollIntervalMs, batchSize } = this.config.campaigns;
    if (!dispatchEnabled || !this.executor.available) {
      this.logger.log('campaign dispatch is disabled on this instance (CAMPAIGN_DISPATCH_ENABLED)');
      return;
    }
    this.logger.log({ msg: 'campaign executor started', pollIntervalMs, batchSize });
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.cycle;
  }

  /** Whether a cycle is scheduled or running. */
  isRunning(): boolean {
    return this.timer !== null || this.cycle !== null;
  }

  private async runCycle(): Promise<void> {
    try {
      await this.executor.tick();
    } catch (error) {
      this.logger.error({
        msg: 'campaign executor cycle failed; retrying at the next poll',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    const delayMs =
      this.config.campaigns.pollIntervalMs *
      (1 - CAMPAIGN_POLL_JITTER + Math.random() * 2 * CAMPAIGN_POLL_JITTER);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.cycle = this.runCycle().finally(() => {
        this.cycle = null;
        this.scheduleNext();
      });
    }, delayMs);
    this.timer.unref();
  }
}
