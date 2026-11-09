import { describeDualControlThreshold } from './billing-controls-startup.log';

/** Phase 7 PR 7-6c (O-2): the startup record of the dual-control threshold in force. */
describe('the dual-control threshold startup line', () => {
  it('unset: every charge and write-off needs a second approver', () => {
    expect(describeDualControlThreshold(null)).toMatch(
      /BILLING_DUAL_CONTROL_THRESHOLD_PAISE\): unset; every unknown-outcome charge and write-off requires a second approver/,
    );
  });

  it('set: names the value and keeps dual control above it and for unevidenced charges', () => {
    expect(describeDualControlThreshold(2500)).toMatch(
      /2500 paise; resolutions above it, and every charge without provider evidence, require a second approver/,
    );
    expect(describeDualControlThreshold(0)).toMatch(/: 0 paise;/);
  });
});
