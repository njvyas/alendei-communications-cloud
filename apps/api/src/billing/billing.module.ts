import { Module } from '@nestjs/common';

import { BillingControlsStartupLog } from './billing-controls-startup.log';
import { BillingReadController } from './billing-read.controller';
import { BillingReadService } from './billing-read.service';
import { LedgerPartitionStartupCheck } from './ledger-partition-startup.check';
import { MessageReservationService } from './message-reservation.service';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';
import { UnknownOutcomeRegisterController } from './unknown-register.controller';
import { UnknownOutcomeRegisterService } from './unknown-register.service';
import { UnknownResolutionController } from './unknown-resolution.controller';
import { UnknownResolutionService } from './unknown-resolution.service';

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
 * - PR 7-6b: the unknown-outcome register (platform, `billing.manage`, read-only).
 * - PR 7-6c: operator resolution of unknown outcomes (platform, `billing.manage`, dual
 *   control; charges and write-offs executed by the 0057 definers), and the startup log
 *   of the dual-control threshold.
 *
 * No account creation, recharge or other money movement here (7-6d).
 */
@Module({
  controllers: [
    PricingController,
    BillingReadController,
    UnknownOutcomeRegisterController,
    UnknownResolutionController,
  ],
  providers: [
    LedgerPartitionStartupCheck,
    PricingService,
    MessageReservationService,
    BillingReadService,
    UnknownOutcomeRegisterService,
    UnknownResolutionService,
    BillingControlsStartupLog,
  ],
  exports: [MessageReservationService],
})
export class BillingModule {}
