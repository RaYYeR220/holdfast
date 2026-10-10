export interface Policy {
  /** Share of the treasury's ZEC to hedge. */
  hedgeRatioBps: number;
  /** Smallest gap between target and actual short, in lots, worth trading. */
  bandLots: number;
  /** New short exposure is refused once notional / equity would exceed this. */
  maxLeverage: number;
  /** Margin ratio a fresh lock or a top-up aims for. */
  marginTargetBps: number;
  /** Margin ratio (equity / short notional) below which the short is cut. */
  deRiskTriggerBps: number;
  /**
   * Margin ratio the cut brings the short back to. Kept under the leverage
   * floor so the controller cannot sell again what it has just bought back.
   */
  deRiskRestoreBps: number;
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
  maxLeverage: 2,
  marginTargetBps: 8_000,
  deRiskTriggerBps: 2_000,
  deRiskRestoreBps: 3_000,
  topUpWarnBps: 6_400,
  sweepAboveBps: 16_000,
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
  range('deRiskTriggerBps', 1, 10_000);
  range('deRiskRestoreBps', 1, 10_000);
  if (errors.length > 0) return { ok: false, errors };

  const leverageFloorBps = 10_000 / (p.maxLeverage as number);
  const trigger = p.deRiskTriggerBps as number;
  const restore = p.deRiskRestoreBps as number;
  if (restore <= trigger) errors.push('deRiskRestoreBps must be above deRiskTriggerBps');
  if (restore >= leverageFloorBps) {
    errors.push(`deRiskRestoreBps must be below the leverage floor of ${Math.floor(leverageFloorBps)} bps`);
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
