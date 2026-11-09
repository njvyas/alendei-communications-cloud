import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { AppConfigService } from '../config/app-config.service';

/**
 * Phase 7 PR 7-6c (`DECISIONS.md` §1zi.12, owner decision O-2): logs, once at startup,
 * the dual-control threshold in force for operator resolution of unknown outcomes
 * (`BILLING_DUAL_CONTROL_THRESHOLD_PAISE`), and — Phase 7 PR 7-6d-1 (D-76d-1) — for
 * credit-limit increases, measured on the increase. It is changed only by a controlled
 * deployment with owner approval; this line is the deployment's record of the value.
 */
@Injectable()
export class BillingControlsStartupLog implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingControlsStartupLog.name);

  constructor(private readonly config: AppConfigService) {}

  onApplicationBootstrap(): void {
    this.logger.log(describeDualControlThreshold(this.config.billing.dualControlThresholdPaise));
  }
}

/** The startup line for a threshold; exported for tests. */
export function describeDualControlThreshold(threshold: number | null): string {
  return threshold === null
    ? 'Billing dual-control threshold (BILLING_DUAL_CONTROL_THRESHOLD_PAISE): unset; every unknown-outcome charge and write-off requires a second approver, as does every credit-limit increase.'
    : `Billing dual-control threshold (BILLING_DUAL_CONTROL_THRESHOLD_PAISE): ${threshold} paise; resolutions above it, and every charge without provider evidence, require a second approver; so do credit-limit increases larger than it.`;
}
