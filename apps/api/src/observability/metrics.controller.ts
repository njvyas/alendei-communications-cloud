import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';
import { Public } from '../auth/public.decorator';

/**
 * Prometheus scrape endpoint. Mounted outside the versioned API prefix so the
 * scrape path is stable across API versions (`OBSERVABILITY.md` §3).
 */
@ApiExcludeController()
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.contentType);
    response.send(await this.metrics.scrape());
  }
}
