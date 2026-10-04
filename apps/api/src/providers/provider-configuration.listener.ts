import {
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { PROVIDER_CONFIGURATION_CACHE } from '@acc/contracts';
import { Client } from 'pg';

import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { ProviderConfigurationCache } from './provider-configuration.cache';

/**
 * The instance's `LISTEN` connection for configuration notifications (Phase
 * 2.4, `PROVIDER_ADAPTER.md` §3a.3, §3a.5).
 *
 * A dedicated connection as `acc_app` (LISTEN needs no table privilege and
 * reads nothing). Each notification's payload is handed to the cache as a hint
 * — never applied as data. The connection is an **accelerator**: if it is lost
 * the cache is marked dirty at once (missed notifications cannot be trusted),
 * reconciliation bounds staleness meanwhile, and the listener reconnects with
 * backoff and listens again. It never fails application start.
 */
@Injectable()
export class ProviderConfigurationListener implements OnModuleInit, OnApplicationShutdown {
  static readonly APPLICATION_NAME = 'acc-provider-config-listener';
  private readonly logger = new Logger(ProviderConfigurationListener.name);
  private client: Client | null = null;
  private stopping = false;
  private delayMs: number = PROVIDER_CONFIGURATION_CACHE.LISTENER_RECONNECT_MIN_MS;
  private reconnect: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly cache: ProviderConfigurationCache,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit(): void {
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }

  /** Whether the LISTEN connection is currently established. */
  isConnected(): boolean {
    return this.client !== null;
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const client = new Client({
      connectionString: this.config.database.appUrl,
      ssl: this.config.database.ssl,
      application_name: ProviderConfigurationListener.APPLICATION_NAME,
    });
    client.on('notification', (message) => {
      if (message.channel !== PROVIDER_CONFIGURATION_CACHE.NOTIFY_CHANNEL) return;
      this.cache.hint(message.payload ?? '');
    });
    client.on('error', () => this.lost(client));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${PROVIDER_CONFIGURATION_CACHE.NOTIFY_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      this.logger.warn({
        msg: 'provider configuration listener could not connect; reconciliation bounds staleness meanwhile',
        error: error instanceof Error ? error.message : String(error),
        retryInMs: this.delayMs,
      });
      this.scheduleReconnect();
      return;
    }
    if (this.stopping) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.delayMs = PROVIDER_CONFIGURATION_CACHE.LISTENER_RECONNECT_MIN_MS;
    // Anything announced while we were not listening is unknown: reload.
    this.cache.invalidateListenerLost();
    this.metrics?.providerConfigListenerConnected.set(1);
    this.metrics?.providerConfigListenerEvents.inc({ outcome: 'connected' });
  }

  private lost(client: Client): void {
    if (this.client !== client) return; // an earlier or failed connection
    this.client = null;
    this.cache.invalidateListenerLost();
    this.metrics?.providerConfigListenerConnected.set(0);
    if (this.stopping) return;
    this.metrics?.providerConfigListenerEvents.inc({ outcome: 'lost' });
    this.logger.warn({
      msg: 'provider configuration listener lost; snapshot marked dirty, reconnecting',
      retryInMs: this.delayMs,
    });
    void client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.connect();
    }, this.delayMs);
    this.reconnect.unref();
    this.delayMs = Math.min(
      this.delayMs * 2,
      PROVIDER_CONFIGURATION_CACHE.LISTENER_RECONNECT_MAX_MS,
    );
  }
}
