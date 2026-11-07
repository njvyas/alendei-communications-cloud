/**
 * Phase 5.0 PR-C — the public provider webhook ingress route (design spec Rev 2 §E.1).
 *
 *   POST /api/v1/webhooks/providers/:providerKey
 *
 * `@Public()`: providers authenticate by the opaque ingress key in the path and the
 * adapter-owned signature over the raw body — never by a session, cookie or API key, so
 * the global AuthGuard is skipped, and CSRF (cookie-only) does not apply. Excluded from
 * the customer OpenAPI document (OD-10). Registered in the public-route allow-list of
 * `route-authorization-coverage.sec-spec.ts` with this reason.
 *
 * **Disabled unless `DELIVERY_WEBHOOKS_ENABLED=true`:** answers 404 and touches nothing (no
 * acc_delivery pool exists). The flag must stay false in every environment until the
 * reverse-proxy access-log redaction of this path (OD-19) is in place and verified there.
 *
 * The path parameter is the key: it is never logged (`ingress-path.ts`), and every error
 * body is uniform and path-free.
 */
import { Controller, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ERROR_CODES } from '@acc/contracts';
import type { Request } from 'express';

import { Public } from '../auth/public.decorator';
import { AppException } from '../common/errors/app.exception';
import { AppConfigService } from '../config/app-config.service';
import { INGRESS_CONTROLLER_PATH } from './ingress-path';
import { ingressRawBody } from './webhook-body-parsing';
import { WebhookIngressService } from './webhook-ingress.service';

@ApiExcludeController()
@Controller(INGRESS_CONTROLLER_PATH)
export class ProviderWebhooksController {
  constructor(
    private readonly config: AppConfigService,
    private readonly ingress: WebhookIngressService,
  ) {}

  @Post(':providerKey')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(@Param('providerKey') providerKey: string, @Req() request: Request) {
    if (!this.config.delivery.webhooksEnabled) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Not found',
        retryable: false,
      });
    }
    const result = await this.ingress.handle({
      providerKey,
      headers: request.headers,
      rawBody: ingressRawBody(request),
      contentType: request.headers['content-type'],
      ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      receivedAt: new Date(),
    });
    return { data: result };
  }
}
