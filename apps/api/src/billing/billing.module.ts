import { Module } from '@nestjs/common';

import { BillingReadController } from './billing-read.controller';
import { BillingReadService } from './billing-read.service';
import { LedgerPartitionStartupCheck } from './ledger-partition-startup.check';
import { MessageReservationService } from './message-reservation.service';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/**
 * Phase 7 billing (`DECISIONS.md` §1zi).
 *
 * - PR 7-1: the read-only ledger partition startup check.
 * - PR 7-2: platform pricing administration (rate cards, provider cost rates,
 *   assignments).
 * - PR 7-4: funds reservation at submission (`MessageReservationService`, used by
 *   the message submission core only, under `BILLING_ENFORCEMENT_ENABLED`).
 *
 * - PR 7-6a: tenant billing reads (`BillingReadController`, `billing.read`, read-only).
 *
 * No account creation or money movement here.
 */
@Module({
  controllers: [PricingController, BillingReadController],
  providers: [
    LedgerPartitionStartupCheck,
    PricingService,
    MessageReservationService,
    BillingReadService,
  ],
  exports: [MessageReservationService],
})
export class BillingModule {}
