export interface DeRiskRung {
  /** Margin ratio (equity / short notional) below which this rung fires. */
  marginRatioBps: number;
  /** Share of the current short to buy back when it fires. */
  reduceBps: number;
}

export interface Policy {
  /** Share of the treasury's ZEC to hedge. */
  hedgeRatioBps: number;
  /** Smallest gap between target and actual short, in lots, worth trading. */
  bandLots: number;
  /** New short exposure is refused once notional / equity would exceed this. */
  maxLeverage: number;
  /** Margin ratio a fresh lock or a top-up aims for. */
  marginTargetBps: number;
  /** Buy-backs that keep the short away from liquidation, highest ratio first. */
  deRisk: DeRiskRung[];
  /** Margin ratio below which the treasurer is asked to add margin. */
  topUpWarnBps: number;
  /** Margin ratio above which excess margin is offered back. */
  sweepAboveBps: number;
  /** Distance of an IOC limit from the mark. */
  maxSlippageBps: number;
  /** Trailing funding APR (to shorts) below which no new short is opened. */
  fundingFloorAprBps: number;
  maxMarkOracleDivBps: number;
  maxOracleRefDivBps: number;
  maxDataAgeMs: number;
  /** Venue minimum order value in dollars. */
  minOrderUsd: number;
}

export const DEFAULT_POLICY: Policy = {
  hedgeRatioBps: 10_000,
  bandLots: 1,
  maxLeverage: 3,
  marginTargetBps: 4_500,
  deRisk: [
    { marginRatioBps: 2_000, reduceBps: 2_500 },
    { marginRatioBps: 1_300, reduceBps: 5_000 },
    { marginRatioBps: 900, reduceBps: 10_000 },
  ],
  topUpWarnBps: 3_000,
  sweepAboveBps: 9_000,
  maxSlippageBps: 30,
  fundingFloorAprBps: -500,
  maxMarkOracleDivBps: 100,
  maxOracleRefDivBps: 150,
  maxDataAgeMs: 180_000,
  minOrderUsd: 10,
};

const KEYS = Object.keys(DEFAULT_POLICY) as (keyof Policy)[];

export type PolicyValidation = { ok: true; policy: Policy } | { ok: false; errors: string[] };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validatePolicy(input: unknown): PolicyValidation {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['policy must be an object'] };
  }
  const p = input as Record<string, unknown>;

  for (const key of Object.keys(p)) {
    if (!KEYS.includes(key as keyof Policy)) errors.push(`unknown field ${key}`);
  }
  for (const key of KEYS) {
    if (!(key in p)) errors.push(`missing field ${key}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const range = (key: keyof Policy, min: number, max: number, integer = true) => {
    const v = p[key];
    const valid = integer ? isInt(v) : isNum(v);
    if (!valid || (v as number) < min || (v as number) > max) {
      errors.push(`${key} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`);
    }
  };

  range('hedgeRatioBps', 0, 10_000);
  range('bandLots', 1, 1_000_000);
  range('maxLeverage', 1, 10, false);
  range('marginTargetBps', 1, 100_000);
  range('topUpWarnBps', 1, 100_000);
  range('sweepAboveBps', 1, 1_000_000);
  range('maxSlippageBps', 1, 500);
  range('fundingFloorAprBps', -100_000, 100_000);
  range('maxMarkOracleDivBps', 1, 2_000);
  range('maxOracleRefDivBps', 1, 2_000);
  range('maxDataAgeMs', 1_000, 3_600_000);
  range('minOrderUsd', 0, 1_000_000, false);

  const rungs = p.deRisk;
  if (!Array.isArray(rungs) || rungs.length === 0) {
    errors.push('deRisk must be a non-empty list');
  }
  if (errors.length > 0) return { ok: false, errors };

  const leverageFloorBps = 10_000 / (p.maxLeverage as number);
  let previous = Number.POSITIVE_INFINITY;
  for (const [i, raw] of (rungs as unknown[]).entries()) {
    const rung = raw as Partial<DeRiskRung> | null;
    if (
      typeof rung !== 'object' ||
      rung === null ||
      !isInt(rung.marginRatioBps) ||
      !isInt(rung.reduceBps) ||
      Object.keys(rung).length !== 2
    ) {
      errors.push(`deRisk[${i}] must be { marginRatioBps, reduceBps }`);
      continue;
    }
    if (rung.marginRatioBps <= 0 || rung.marginRatioBps >= leverageFloorBps) {
      errors.push(
        `deRisk[${i}].marginRatioBps must be below the leverage floor of ${Math.floor(leverageFloorBps)} bps`,
      );
    }
    if (rung.reduceBps <= 0 || rung.reduceBps > 10_000) {
      errors.push(`deRisk[${i}].reduceBps must be in (0, 10000]`);
    }
    if (rung.marginRatioBps >= previous) {
      errors.push(`deRisk[${i}] must be listed from the highest margin ratio to the lowest`);
    }
    previous = rung.marginRatioBps;
  }

  const target = p.marginTargetBps as number;
  if (target < leverageFloorBps) {
    errors.push(`marginTargetBps must be at least the leverage floor of ${Math.ceil(leverageFloorBps)} bps`);
  }
  if ((p.sweepAboveBps as number) <= target) errors.push('sweepAboveBps must be above marginTargetBps');
  if ((p.topUpWarnBps as number) >= target) errors.push('topUpWarnBps must be below marginTargetBps');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: p as unknown as Policy };
}
