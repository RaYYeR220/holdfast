import type { Policy } from '../src/policy';

/**
 * A fixed policy for unit tests, so that tuning the shipped default never
 * moves the arithmetic these tests pin down. Thin margin, 3x cap.
 */
export const LEAN_POLICY: Policy = {
  hedgeRatioBps: 10_000,
  bandLots: 1,
  maxLeverage: 3,
  marginTargetBps: 4_500,
  deRiskTriggerBps: 2_000,
  deRiskRestoreBps: 2_800,
  topUpWarnBps: 3_000,
  sweepAboveBps: 9_000,
  maxSlippageBps: 30,
  fundingFloorAprBps: -500,
  maxMarkOracleDivBps: 100,
  maxOracleRefDivBps: 150,
  maxDataAgeMs: 180_000,
  minOrderUsd: 10,
};
