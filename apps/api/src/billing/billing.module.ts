import { Module } from '@nestjs/common';

import { LedgerPartitionStartupCheck } from './ledger-partition-startup.check';

/**
 * Phase 7 billing (PR 7-1, `DECISIONS.md` §1zi). PR 7-1 contributes only the
 * ledger partition startup check: no controller, no route, no billing
 * enforcement, no account creation and no money movement.
 */
@Module({
  providers: [LedgerPartitionStartupCheck],
})
export class BillingModule {}
