import { type Zat, zatToZec } from './units';

const HOURS_PER_YEAR = 24 * 365;

/** Dollar value of everything the treasury controls across the three legs. */
export function navUsd(i: {
  treasuryZat: Zat;
  px: number;
  hlAccountValueUsd: number;
  payoutFloatUsd: number;
}): number {
  return zatToZec(i.treasuryZat) * i.px + i.hlAccountValueUsd + i.payoutFloatUsd;
}

/**
 * Change in value since the lock that the lock itself is responsible for.
 * Money that came in or went out on purpose is not drift.
 */
export function driftUsd(i: { navNow: number; navAtLock: number; externalFlowsUsd: number }): number {
  return i.navNow - i.navAtLock - i.externalFlowsUsd;
}

export function runwayMonths(nav: number, monthlyBurnUsd: number): number | null {
  if (!(monthlyBurnUsd > 0)) return null;
  return Math.max(0, nav) / monthlyBurnUsd;
}

/** Annualised funding from hourly rates; positive means shorts are paid. */
export function fundingAprBps(hourlyRates: number[]): number {
  if (hourlyRates.length === 0) return 0;
  const mean = hourlyRates.reduce((a, b) => a + b, 0) / hourlyRates.length;
  return Math.round(mean * HOURS_PER_YEAR * 10_000);
}
