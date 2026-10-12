import type { Policy } from '@holdfast/core';
import type { JournalEntry } from '@holdfast/engine';
import { formatBps, formatNumber, formatUsd } from '../../../ui/format';
import type { State } from '../../../ui/onebit/patterns';
import type { Standing } from './scale';

/**
 * The lock in words: what a journal entry decided and why, what an order
 * did, who is paying whom in funding, and where the margin ratio stands
 * against the policy. Every sentence is built from the figures the server
 * returned and adds none of its own.
 */

/** A journal entry as it arrives from the server on either side: amounts may be bigint or their decimal digits. */
export type EntryShown = Pick<JournalEntry, 'seq' | 'at' | 'digest' | 'decision' | 'order' | 'errors' | 'advisories'>;

const LOTS_PER_ZEC = 100;

/** Lots as ZEC: one lot is 0.01 ZEC. */
export function lotsAsZec(lots: number): string {
  return `${formatNumber(lots / LOTS_PER_ZEC, 2)} ZEC`;
}

export function lotsWords(lots: number): string {
  return `${formatNumber(lots)} ${lots === 1 ? 'lot' : 'lots'}`;
}

/** A price as the venue writes one: dollars with two decimals, no sign. */
export function formatPx(px: number): string {
  return formatUsd(px, 2);
}

const MODE: Record<JournalEntry['decision']['mode'], string> = { HOLD: 'Hold', REBALANCE: 'Rebalance', DERISK: 'Buy-back' };

/** The controller's mode in the product's words. The buy-back ladder is the mode the code calls DERISK. */
export function modeWord(mode: JournalEntry['decision']['mode']): string {
  return MODE[mode];
}

const SOURCE: Record<JournalEntry['errors'][number]['source'], string> = { treasury: 'Zcash', venue: 'Hyperliquid', reference: 'The reference price' };

const sentence = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
};

export interface DecisionWords {
  mode: string;
  /** What it decided, each line a sentence: reasons first, then refusals, then sources that failed. */
  lines: string[];
  /** A state the entry carries as a whole: a refusal, or a source that could not be read. */
  state: State | null;
  stateLabel: string | null;
}

export function decisionWords(entry: Pick<EntryShown, 'decision' | 'errors'>): DecisionWords {
  const { decision, errors } = entry;
  const lines = [
    ...decision.reasons.map(sentence),
    ...decision.refusals.map((refusal) => sentence(`refused, ${refusal.detail}`)),
    ...errors.map((error) => sentence(`${SOURCE[error.source]} could not be read: ${error.message}`)),
  ].filter((line) => line !== '');
  if (lines.length === 0) lines.push('Nothing to do.');
  const state: State | null = decision.refusals.length > 0 ? 'refused' : errors.length > 0 ? 'stale' : null;
  return { mode: modeWord(decision.mode), lines, state, stateLabel: state === 'refused' ? 'Refused' : state === 'stale' ? 'Source failed' : null };
}

/** What the order of an entry did, in one sentence; null when the entry placed none. */
export function orderWords(order: EntryShown['order']): string | null {
  if (order === null) return null;
  const { side, lots, limitPx, result } = order;
  const verb = side === 'sell' ? 'Sold' : 'Bought back';
  const asked = `${side === 'sell' ? 'Sell' : 'Buy back'} ${lotsAsZec(lots)} at a limit of ${formatPx(limitPx)}`;
  if (!result.ok) return `${asked}: not filled. ${sentence(result.error ?? 'the venue gave no reason')}`;
  const at = result.avgPx === null ? '' : ` at ${formatPx(result.avgPx)}`;
  const id = result.oid === null ? '' : `, order ${result.oid}`;
  if (result.filledLots === lots) return `${verb} ${lotsAsZec(lots)}${at}${id}.`;
  return `${verb} ${lotsAsZec(result.filledLots)} of ${lotsAsZec(lots)}${at}${id}.`;
}

export interface FundingWords {
  /** Who pays whom, as a sentence. */
  who: string;
  /** What that means for the lock under this policy. */
  consequence: string;
  /** True when the rate is under the policy's floor, so that no new short is opened. */
  underFloor: boolean;
}

export function fundingWords(aprBps: number, policy: Pick<Policy, 'fundingFloorAprBps'>): FundingWords {
  const floor = formatBps(policy.fundingFloorAprBps);
  const underFloor = aprBps < policy.fundingFloorAprBps;
  if (aprBps > 0) return { who: 'Longs are paying shorts, so the account receives funding on its short.', consequence: `The rate is over the floor of ${floor} a year. It is a trailing rate and can turn.`, underFloor };
  if (aprBps === 0) return { who: 'Nobody is paying: the trailing rate is zero.', consequence: `The rate is over the floor of ${floor} a year.`, underFloor };
  return {
    who: 'Shorts are paying longs, so the account pays funding on its short.',
    consequence: underFloor ? `The rate is under the floor of ${floor} a year: the controller opens no new short while it stays there. An open short is kept.` : `The rate is still over the floor of ${floor} a year, under which no new short is opened.`,
    underFloor,
  };
}

type Levels = Pick<Policy, 'marginTargetBps' | 'topUpWarnBps' | 'deRiskTriggerBps' | 'deRiskRestoreBps'>;

/** Where the margin ratio stands against the policy, as a tag and a sentence. */
export function standingWords(standing: Standing, levels: Levels): { state: State; label: string; text: string } {
  const target = formatBps(levels.marginTargetBps);
  const topUp = formatBps(levels.topUpWarnBps);
  const floor = formatBps(levels.deRiskTriggerBps);
  const restore = formatBps(levels.deRiskRestoreBps);
  switch (standing) {
    case 'none':
      return { state: 'unlocked', label: 'No short', text: 'There is no short on the account, so there is no margin ratio to hold against the policy.' };
    case 'buyBack':
      return { state: 'refused', label: 'Under the floor', text: `The ratio is under the buy-back floor of ${floor}. At its next tick the controller buys back part of the short, down to what the margin carries at ${restore}.` };
    case 'topUp':
      return { state: 'limit', label: 'Top-up asked', text: `The ratio is under the top-up threshold of ${topUp}. The service asks the treasurer for margin back to ${target}; it cannot add margin itself.` };
    case 'belowTarget':
      return { state: 'locked', label: 'Holding', text: `The ratio is between the top-up threshold of ${topUp} and the target of ${target}. Nothing is asked of the treasurer.` };
    case 'atTarget':
      return { state: 'locked', label: 'Holding', text: `The ratio is at or over the target of ${target}. Nothing is asked of the treasurer.` };
  }
}

export interface SwitchInput {
  /** What the switch is being set to. */
  enable: boolean;
  policy: Pick<Policy, 'maxSlippageBps' | 'maxLeverage' | 'maxDataAgeMs' | 'hedgeRatioBps'>;
  /** The short on the account now, in lots; null when the venue could not be read. */
  shortLots: number | null;
  /** The short the treasury calls for at this balance, in lots; null when it could not be worked out. */
  targetLots: number | null;
  /** Whether the venue shows the agent key approved; null when that could not be read. */
  agentApproved: boolean | null;
}

export interface SwitchWords {
  title: string;
  /** What the controller will do at its next tick, a sentence to a line. */
  lines: string[];
  confirm: string;
}

/**
 * What switching the lock does, stated before it is switched: the switch
 * records the treasurer's wish and sends nothing; the controller acts on it
 * at its next tick, under the same guards as ever.
 */
export function switchWords(input: SwitchInput): SwitchWords {
  const { enable, policy, shortLots, targetLots, agentApproved } = input;
  const slippage = formatBps(policy.maxSlippageBps, 2);
  if (!enable) {
    const short = shortLots === null ? 'whatever short is open' : shortLots > 0 ? `the whole short of ${lotsWords(shortLots)}, ${lotsAsZec(shortLots)}` : null;
    return {
      title: 'Switch the lock off',
      lines: [
        'Off means a target of no short at all. The switch records that and sends nothing itself.',
        short === null
          ? 'No short is open, so at its next tick the controller has nothing to buy back. It opens nothing new while the lock is off.'
          : `At its next tick, within about a minute, the controller buys back ${short}, with one immediate-or-cancel limit at most ${slippage} over the mark. It opens nothing new while the lock is off.`,
        'The treasury’s dollar value is then no longer fixed: it moves with the price of ZEC.',
        'The margin stays on your Hyperliquid account. Withdrawing it is yours to do; the service’s key cannot.',
      ],
      confirm: 'Switch the lock off',
    };
  }
  const target = targetLots === null ? 'the short the treasury calls for' : targetLots > 0 ? `a short of ${lotsWords(targetLots)}, ${lotsAsZec(targetLots)}, which is what the treasury calls for now` : null;
  const lines = [
    'On means the controller keeps a short ZEC perpetual sized to the treasury. The switch records that and sends nothing itself.',
    target === null
      ? 'At this balance the policy calls for no short, so the controller holds until the treasury covers at least one lot of 0.01 ZEC.'
      : `At its next tick, within about a minute, the controller reads the treasury, the venue and the reference price. If every reading is under ${formatNumber(policy.maxDataAgeMs / 1000)} s old and every guard is quiet, it sells towards ${target}: one immediate-or-cancel limit at most ${slippage} under the mark, and never more than the margin carries at ${policy.maxLeverage}×.`,
    'A short needs margin on your Hyperliquid account. With none there the controller places no order and writes the reason in the journal.',
  ];
  if (agentApproved === false) lines.push('The venue does not show the agent key approved yet. Until it is, the controller can place no order.');
  if (agentApproved === null) lines.push('Whether the agent key is approved could not be read. Without the approval the controller can place no order.');
  lines.push('A lock gives up the rise as well as the fall, and needs margin top-ups in a strong rally: an ignored top-up request can end worse than no lock.');
  return { title: 'Switch the lock on', lines, confirm: 'Switch the lock on' };
}
