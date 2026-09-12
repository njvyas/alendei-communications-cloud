import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { AppConfigService } from '../config/app-config.service';
import { DatabaseHealthIndicator } from './database.health';
import { RedisHealthIndicator } from './redis.health';

/**
 * Liveness and readiness (`API.md` §2). Unauthenticated and minimal by design:
 * these endpoints are reachable by anything that can route to the pod, so they
 * disclose no version, topology or dependency detail.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Aggregate health' })
  @HealthCheck()
  async check() {
    return this.health.check([() => this.database.check(), () => this.redis.check()]);
  }

  /**
   * Liveness: is this process running and able to respond at all? It never
   * touches a dependency — a database outage must not cause the orchestrator to
   * kill and restart every replica.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok'; service: string } {
    return { status: 'ok', service: this.config.serviceName };
  }

  /**
   * Readiness: should this instance receive traffic? Requires PostgreSQL, since
   * it is the correctness boundary.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe' })
  @HealthCheck()
  async ready() {
    return this.health.check([() => this.database.check(), () => this.redis.check()]);
  }
}
