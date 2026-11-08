import { Module } from '@nestjs/common';

import { LedgerPartitionStartupCheck } from './ledger-partition-startup.check';
import { PricingController } from './pricing.controller';
import { PricingService } from './pricing.service';

/**
 * Phase 7 billing (`DECISIONS.md` §1zi).
 *
 * - PR 7-1: the read-only ledger partition startup check.
 * - PR 7-2: platform pricing administration (rate cards, provider cost rates,
 *   assignments). Rating itself is a database function no application role may
 *   execute yet.
 *
 * No billing enforcement, reservation, settlement, account creation or money
 * movement.
 */
@Module({
  controllers: [PricingController],
  providers: [LedgerPartitionStartupCheck, PricingService],
})
export class BillingModule {}
