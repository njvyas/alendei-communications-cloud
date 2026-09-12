import { CallHandler, ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { MetricsService } from './metrics.service';

/**
 * Records request count and latency.
 *
 * The `route` label is the matched route *pattern* (`/api/v1/users/:id`), never
 * the concrete path — using the path would put an unbounded set of identifiers
 * into a Prometheus label, which is exactly what `OBSERVABILITY.md` §3 forbids.
 * An unmatched request is labelled `unmatched` rather than by its raw URL.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const stopTimer = this.metrics.httpDuration.startTimer();

    const record = (): void => {
      const labels = {
        method: request.method,
        route: routePattern(request),
        status: statusClass(response.statusCode),
      };
      stopTimer(labels);
      this.metrics.httpRequests.inc(labels);
    };

    return next.handle().pipe(tap({ next: record, error: record }));
  }
}

function routePattern(request: Request): string {
  const path = request.route?.path;
  if (typeof path !== 'string' || path.length === 0) return 'unmatched';
  const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  return `${base}${path}` || 'unmatched';
}

/** Status *class* keeps this label to five values rather than dozens. */
function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}
