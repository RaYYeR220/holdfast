import type { Zat } from './units';

/** Everything the controller is allowed to look at for one decision. */
export interface Snapshot {
  now: number;
  /** Shielded treasury balance as last read with the viewing key. */
  treasury: { zat: Zat; asOf: number } | null;
  hl: {
    asOf: number;
    markPx: number;
    oraclePx: number;
    /** Short size in lots; negative means the account is long. */
    shortLots: number;
    accountValueUsd: number;
    /** Trailing funding APR paid to shorts. */
    fundingAprBps: number;
  } | null;
  /** Independent ZEC/USD price used to cross-check the venue oracle. */
  ref: { px: number; asOf: number } | null;
}

export type Action =
  | { kind: 'increaseShort'; lots: number; limitPx: number }
  | { kind: 'reduceShort'; lots: number; limitPx: number };

export type RefusalCode =
  | 'STALE_TREASURY'
  | 'STALE_HL'
  | 'STALE_REF'
  | 'MARK_ORACLE_DIVERGENCE'
  | 'ORACLE_REF_DIVERGENCE'
  | 'FUNDING_BELOW_FLOOR'
  | 'LEVERAGE_CAP'
  | 'NO_MARGIN'
  | 'UNEXPECTED_LONG'
  | 'BELOW_MIN_ORDER';

export interface Refusal {
  code: RefusalCode;
  detail: string;
}

export interface Decision {
  mode: 'HOLD' | 'REBALANCE' | 'DERISK';
  /** Short size the treasury calls for, when the treasury is readable. */
  targetLots: number | null;
  /** Equity over short notional, when there is a short. */
  marginRatioBps: number | null;
  actions: Action[];
  refusals: Refusal[];
  reasons: string[];
}
