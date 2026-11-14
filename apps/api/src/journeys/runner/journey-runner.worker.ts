import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { JourneyRunnerService } from './journey-runner.service';
import { JourneyTriggerProcessingService } from './journey-trigger-processing.service';

/** ±20 % around the poll interval (handover §8.2), so instances started together drift apart. */
export const JOURNEY_POLL_JITTER = 0.2;

/**
 * Phase 8C PR 8C-3: the journey runner loop — a single `setTimeout` chain over the PostgreSQL
 * claim table, exactly as `DispatchWorker` (no queue library, cron or `@nestjs/schedule`).
 *
 * **Off by default.** It starts only when `JOURNEY_RUNNER_ENABLED` is true, which configuration
 * refuses outside tests (`journeyRunnerProblems`) until enablement is separately authorised,
 * AND the `acc_journey` connection exists. Otherwise it logs that it is disabled and does
 * nothing at all.
 */
@Injectable()
export class JourneyRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JourneyRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: JourneyRunnerService,
    private readonly triggers: JourneyTriggerProcessingService,
  ) {}

  onApplicationBootstrap(): void {
    const { runnerEnabled, pollIntervalMs, batchSize } = this.config.journeys;
    if (!runnerEnabled || !this.runner.available) {
      this.logger.log('journey runner is disabled on this instance (JOURNEY_RUNNER_ENABLED)');
      return;
    }
    this.logger.log({ msg: 'journey runner started', pollIntervalMs, batchSize });
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
    const { eventIntakeEnabled, schedulerEnabled } = this.config.journeys;
    // 8C-4: event intake and scheduled firing, each behind its own flag (off; refused outside
    // tests). A failure in one part never stops the others.
    if (eventIntakeEnabled && this.triggers.available) {
      try {
        await this.triggers.processEvents();
        await this.triggers.purgeEvents();
      } catch (error) {
        this.logger.error({
          msg: 'journey event intake failed; retrying at the next poll',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (schedulerEnabled && this.triggers.available) {
      try {
        await this.triggers.fireDueSchedules();
      } catch (error) {
        this.logger.error({
          msg: 'journey schedule firing failed; retrying at the next poll',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.runner.tick();
    } catch (error) {
      this.logger.error({
        msg: 'journey runner cycle failed; retrying at the next poll',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    const delayMs =
      this.config.journeys.pollIntervalMs *
      (1 - JOURNEY_POLL_JITTER + Math.random() * 2 * JOURNEY_POLL_JITTER);
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
