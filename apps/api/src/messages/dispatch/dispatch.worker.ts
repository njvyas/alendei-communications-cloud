import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { DispatcherService } from './dispatcher.service';

/** ±20 % around the poll interval (ADR-014 D18), so instances started together drift apart. */
export const POLL_JITTER = 0.2;

/**
 * The instance's dispatch loop (ADR-014 §9, D18): every poll interval, with
 * jitter, it recovers expired leases and then claims and processes one batch
 * through `DispatcherService`.
 *
 * PostgreSQL is the only coordination. Claims are taken `FOR UPDATE SKIP
 * LOCKED`, and every write is fenced by the claim token and epoch, so any
 * number of instances — or a cycle that outlived its lease — cannot settle one
 * message twice. Cycles on one instance never overlap: the next is scheduled
 * only when the previous one has finished. A failed cycle is logged and the
 * loop carries on.
 *
 * Shutdown stops scheduling and waits for the cycle in progress, while the
 * dispatch pool is still open (pools close in `onApplicationShutdown`, after
 * every `onModuleDestroy`). Anything interrupted harder than that is settled by
 * lease recovery on the next instance to poll.
 */
@Injectable()
export class DispatchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DispatchWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private stopping = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly dispatcher: DispatcherService,
  ) {}

  onApplicationBootstrap(): void {
    const { workerEnabled, pollIntervalMs, batchSize } = this.config.dispatch;
    if (!workerEnabled) {
      this.logger.log('message dispatch is disabled on this instance (DISPATCH_WORKER_ENABLED)');
      return;
    }
    this.logger.log({ msg: 'message dispatch started', pollIntervalMs, batchSize });
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

  /** One cycle: expired leases first, so a stranded message is settled before new claims. */
  private async runCycle(): Promise<void> {
    try {
      const recovered = await this.dispatcher.recoverExpiredLeases();
      if (recovered > 0) this.logger.warn({ msg: 'recovered expired dispatch leases', recovered });
      if (this.stopping) return;
      await this.dispatcher.dispatchBatch(this.config.dispatch.batchSize);
    } catch (error) {
      this.logger.error({
        msg: 'dispatch cycle failed; retrying at the next poll',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return;
    const delayMs =
      this.config.dispatch.pollIntervalMs * (1 - POLL_JITTER + Math.random() * 2 * POLL_JITTER);
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
