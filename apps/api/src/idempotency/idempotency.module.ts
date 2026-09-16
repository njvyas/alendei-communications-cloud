import { Global, Module } from '@nestjs/common';

import { IdempotencyService } from './idempotency.service';

/**
 * HTTP idempotency (`API.md` §4, ADR-006).
 *
 * Global because it is a request-lifecycle concern rather than a feature of one
 * module, and because every future mutating endpoint should reach it the same
 * way. It holds no business logic: the protected work is a closure it runs
 * inside the transaction it opens.
 */
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
