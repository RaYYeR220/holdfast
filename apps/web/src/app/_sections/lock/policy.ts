import { type Policy, validatePolicy } from '@holdfast/core';
import { formatBps, formatNumber, formatUsd } from '../../../ui/format';

/**
 * The policy as a treasurer reads and edits it: each number with its name,
 * its unit and what it does, and the editor's text turned back into the
 * policy the server stores. Whether a policy is valid is decided by
 * `validatePolicy`, the function the server itself runs; what is added here
 * is the reading of the text and the wording of the refusals.
 */

export type PolicyKey = keyof Policy;

type Unit =
  /** Stored in basis points, written in percent. */
  | 'percent'
  /** Stored in milliseconds, written in seconds. */
  | 'seconds'
  | 'multiple'
  | 'lots'
  | 'dollars';

export interface PolicyField {
  key: PolicyKey;
  label: string;
  unit: Unit;
  /** What follows the figure: "%", "% a year", "×", "s", "lots", "$". */
  suffix: string;
  /** What the number does, as one sentence. */
  meaning: string;
}

export interface PolicyGroup {
  id: 'margin' | 'orders' | 'guards';
  title: string;
  lead: string;
  fields: PolicyField[];
}

const field = (key: PolicyKey, label: string, unit: Unit, suffix: string, meaning: string): PolicyField => ({ key, label, unit, suffix, meaning });

export const POLICY_GROUPS: readonly PolicyGroup[] = [
  {
    id: 'margin',
    title: 'Margin',
    lead: 'The margin ratio is the account value over the size of the short. These five numbers say what happens as it moves.',
    fields: [
      field('marginTargetBps', 'Target margin', 'percent', '%', 'A fresh lock or a top-up aims for margin worth this share of the short.'),
      field('topUpWarnBps', 'Top-up threshold', 'percent', '%', 'Under this ratio the service asks the treasurer for margin back to the target. It cannot add margin itself.'),
      field('deRiskTriggerBps', 'Buy-back floor', 'percent', '%', 'Under this ratio the controller buys back part of the short.'),
      field('deRiskRestoreBps', 'Buy-back ratio', 'percent', '%', 'A buy-back keeps only the short the remaining margin carries at this ratio. Lots bought back are not sold again until margin arrives.'),
      field('sweepAboveBps', 'Excess margin above', 'percent', '%', 'Over this ratio the service says how much margin can be taken back. Taking it back is the treasurer’s to do.'),
    ],
  },
  {
    id: 'orders',
    title: 'Size and orders',
    lead: 'How large the short may be and how an order is sent.',
    fields: [
      field('hedgeRatioBps', 'Hedge ratio', 'percent', '%', 'The share of the treasury’s ZEC the short covers, in lots of 0.01 ZEC.'),
      field('maxLeverage', 'Leverage cap', 'multiple', '×', 'No new short is opened once the short would exceed this multiple of the account value.'),
      field('maxSlippageBps', 'Slippage cap', 'percent', '%', 'Every order is an immediate-or-cancel limit at most this far from the mark.'),
      field('bandLots', 'Rebalance band', 'lots', 'lots', 'A gap between the short and what the treasury calls for smaller than this is left alone.'),
      field('minOrderUsd', 'Smallest order', 'dollars', '$', 'The venue’s minimum order value. A smaller order is not sent, unless it closes the position.'),
    ],
  },
  {
    id: 'guards',
    title: 'Guards',
    lead: 'A guard that is not quiet stops the controller from adding exposure. Buying back needs only fresh venue data.',
    fields: [
      field('maxMarkOracleDivBps', 'Mark against oracle', 'percent', '%', 'No new short while the venue’s mark and its oracle price differ by more than this.'),
      field('maxOracleRefDivBps', 'Oracle against reference', 'percent', '%', 'No new short while the venue’s oracle and the independent reference price differ by more than this.'),
      field('fundingFloorAprBps', 'Funding floor', 'percent', '% a year', 'No new short while funding over the last 72 hours, annualised, is under this rate. Negative means shorts are paying.'),
      field('maxDataAgeMs', 'Oldest reading used', 'seconds', 's', 'A reading older than this counts as missing, and missing data never adds exposure.'),
    ],
  },
];

export const POLICY_FIELDS: readonly PolicyField[] = POLICY_GROUPS.flatMap((group) => group.fields);

const FIELD = new Map(POLICY_FIELDS.map((entry) => [entry.key, entry]));
const fieldOf = (key: PolicyKey): PolicyField => FIELD.get(key) as PolicyField;

/** How many stored units make one written unit. */
const SCALE: Record<Unit, number> = { percent: 100, seconds: 1000, multiple: 1, lots: 1, dollars: 1 };
/** Decimals a written figure may carry. */
const DECIMALS: Record<Unit, number> = { percent: 2, seconds: 3, multiple: 2, lots: 0, dollars: 2 };

const trimZeros = (text: string): string => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

/** A stored value as the editor writes it: a plain decimal, no separators, a hyphen for minus. */
export function toText(key: PolicyKey, value: number): string {
  const { unit } = fieldOf(key);
  return trimZeros((value / SCALE[unit]).toFixed(DECIMALS[unit]));
}

/** A stored value as the page shows it, with its unit. */
export function shown(key: PolicyKey, value: number): string {
  const { unit, suffix } = fieldOf(key);
  if (unit === 'percent') return suffix === '%' ? formatBps(value, value % 100 === 0 ? 1 : 2) : `${formatBps(value, value % 100 === 0 ? 1 : 2)} a year`;
  if (unit === 'seconds') return `${formatNumber(value / 1000, value % 1000 === 0 ? 0 : 1)} s`;
  if (unit === 'multiple') return `${trimZeros(value.toFixed(2))}×`;
  if (unit === 'lots') return `${formatNumber(value)} ${value === 1 ? 'lot' : 'lots'}`;
  return formatUsd(value, Number.isInteger(value) ? 0 : 2);
}

export type PolicyText = Record<PolicyKey, string>;

export function policyToText(policy: Policy): PolicyText {
  return Object.fromEntries(POLICY_FIELDS.map(({ key }) => [key, toText(key, policy[key])])) as PolicyText;
}

export type PolicyErrors = Partial<Record<PolicyKey, string>>;

export type PolicyReading = { ok: true; policy: Policy } | { ok: false; errors: PolicyErrors; general: string[] };

const NUMBER = /^-?\d+(\.\d+)?$/;

/** One figure of the editor as the stored value, or why it cannot be read. */
function readFigure(entry: PolicyField, text: string): { value: number } | { error: string } {
  const written = text.trim().replace(',', '.').replace('−', '-');
  if (written === '') return { error: 'A figure is needed here.' };
  if (!NUMBER.test(written)) return { error: 'Write a plain number, such as 80 or 0.3.' };
  const decimals = written.includes('.') ? written.length - written.indexOf('.') - 1 : 0;
  const allowed = DECIMALS[entry.unit];
  if (decimals > allowed) return { error: allowed === 0 ? 'A whole number is needed here.' : `At most ${allowed} decimals.` };
  const stored = Number(written) * SCALE[entry.unit];
  // Percent and seconds are stored as whole basis points and milliseconds.
  return { value: entry.unit === 'multiple' || entry.unit === 'dollars' ? Number(written) : Math.round(stored) };
}

const RANGE = /^(\w+) must be (?:an integer|a number) in \[(-?[\d.]+), (-?[\d.]+)\]$/;
const LEVERAGE_FLOOR = /^(\w+) must be (below|at least) the leverage floor of (\d+) bps$/;
const RELATION = /^(\w+) must be (above|below) (\w+)$/;

const isKey = (name: string): name is PolicyKey => FIELD.has(name as PolicyKey);
const named = (key: PolicyKey): string => fieldOf(key).label.toLowerCase();

/**
 * The server's reasons for refusing a policy, each put beside the field it
 * is about and written in the units the editor uses. A reason that names no
 * field of the editor is kept as it came.
 */
export function policyProblems(problems: readonly string[]): { errors: PolicyErrors; general: string[] } {
  const errors: PolicyErrors = {};
  const general: string[] = [];
  const put = (key: PolicyKey, text: string) => {
    errors[key] = errors[key] === undefined ? text : `${errors[key]} ${text}`;
  };
  for (const problem of problems) {
    const range = RANGE.exec(problem);
    if (range !== null && isKey(range[1] ?? '')) {
      const key = range[1] as PolicyKey;
      put(key, `Must be between ${shown(key, Number(range[2]))} and ${shown(key, Number(range[3]))}.`);
      continue;
    }
    const floor = LEVERAGE_FLOOR.exec(problem);
    if (floor !== null && isKey(floor[1] ?? '')) {
      const key = floor[1] as PolicyKey;
      put(key, `Must be ${floor[2]} ${formatBps(Number(floor[3]))}, the margin ratio the leverage cap stands for.`);
      continue;
    }
    const relation = RELATION.exec(problem);
    if (relation !== null && isKey(relation[1] ?? '') && isKey(relation[3] ?? '')) {
      put(relation[1] as PolicyKey, `Must be ${relation[2]} the ${named(relation[3] as PolicyKey)}.`);
      continue;
    }
    general.push(problem);
  }
  return { errors, general };
}

/** The editor's text as a policy the server will take, or what is wrong with it, field by field. */
export function readPolicy(text: PolicyText): PolicyReading {
  const errors: PolicyErrors = {};
  const policy: Partial<Policy> = {};
  for (const entry of POLICY_FIELDS) {
    const read = readFigure(entry, text[entry.key] ?? '');
    if ('error' in read) errors[entry.key] = read.error;
    else policy[entry.key] = read.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors, general: [] };
  const checked = validatePolicy(policy);
  if (checked.ok) return { ok: true, policy: checked.policy };
  return { ok: false, ...policyProblems(checked.errors) };
}

/** The policy in one paragraph, with its own numbers. */
export function policyInWords(policy: Policy): string {
  const hedge = shown('hedgeRatioBps', policy.hedgeRatioBps);
  const target = shown('marginTargetBps', policy.marginTargetBps);
  const topUp = shown('topUpWarnBps', policy.topUpWarnBps);
  const floor = shown('deRiskTriggerBps', policy.deRiskTriggerBps);
  const restore = shown('deRiskRestoreBps', policy.deRiskRestoreBps);
  return `The short covers ${hedge} of the treasury’s ZEC. A lock starts with margin worth ${target} of the short. Under ${topUp} the service asks the treasurer for a top-up back to ${target}. Under ${floor} the controller buys back part of the short, down to what the margin carries at ${restore}.`;
}

export interface PolicyChange {
  key: PolicyKey;
  label: string;
  from: string;
  to: string;
}

/** The figures that differ between two policies, as the page shows them, in the order of the editor. */
export function policyChanges(before: Policy, after: Policy): PolicyChange[] {
  return POLICY_FIELDS.filter(({ key }) => before[key] !== after[key]).map(({ key, label }) => ({ key, label, from: shown(key, before[key]), to: shown(key, after[key]) }));
}
