import {
  type Action,
  DEFAULT_POLICY,
  type Hex,
  type OrderResult,
  type OutgoingPayment,
  type OwnedNote,
  type Policy,
  ZERO_ROOT,
  advise,
  decide,
  digest,
} from '@holdfast/core';
import type { JournalEntry, OrderRecord } from '@holdfast/engine';
import type { AssetDirectory, FeeRecord, FundingPayment, HedgeFill, LedgerInput, PayoutEvidence, PayoutRunRecord, PricePoint, SwapRecord } from '../src/index';

export const ORG = 'holdfast-demo';
export const POLICY: Policy = DEFAULT_POLICY;
export const HL_ACCOUNT = '0xda22459d4776c240e9182be9e569f07617cef664';
export const BIRTHDAY = 3_512_000;

const at = (iso: string) => Date.parse(iso);

/**
 * The demo treasury's first day on mainnet: a grant payment arrives, part of
 * it is swapped into margin on Hyperliquid, and the controller opens the
 * short. Amounts, transaction ids, the fill and its order ids are the real
 * ones; block heights and times of day are set here.
 */
export const RECEIPT_TX = '27472243738462004e72b46b2b2f3ba20318d36d3ee1f0fbcb93ef5aa2e6ff84';
export const SPEND_TX = '2b3865fbbd334d4db4d1da760d2d8be30c72a89368e3bb6fbf7f2c9b42c00a7e';
export const ARRIVAL_TX = '0xa52944568cd2b32e48f277ee1c8728746036fc0b6f264fb009ab68e595745e10';
export const GRANT_MEMO = 'ZCG grant, milestone 2 of 4. Paid to the Holdfast demo treasury.';
export const CLOID: Hex = '0xd5ce6801a6783b879b84d9c8a4be53ab';
export const OID = '570748779376';
export const SWAP_ID = '0d7c2b0e-52a4-4c7b-9f0e-3a1d5b8c6e21';
export const DEPOSIT_ADDRESS = 't1Rz5oeDUphb5vwrFvUXi9xWtyTTsLGvF6C';

export const RECEIPT_HEIGHT = 3_512_410;
export const SPEND_HEIGHT = 3_512_594;
export const RECEIPT_TIME = at('2026-10-09T10:12:31Z');
export const SPEND_TIME = at('2026-10-09T14:03:20Z');
export const ARRIVAL_TIME = at('2026-10-09T14:11:48Z');
export const FILL_TIME = at('2026-10-09T14:20:07.412Z');
export const NOW = at('2026-10-09T16:30:30Z');

export const ZEC_ID = 'nep141:zec.omft.near';
export const USDC_HYPERCORE_ID = '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054';
export const USDC_SOLANA_ID = 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near';

export const receiptNote: OwnedNote = {
  id: `${RECEIPT_TX}:orchard:${'c1'.repeat(32)}`,
  txid: RECEIPT_TX,
  height: RECEIPT_HEIGHT,
  time: RECEIPT_TIME,
  zat: 1_975_000n,
  memo: GRANT_MEMO,
  pool: 'orchard',
  kind: 'incoming',
  nullifier: 'a1'.repeat(32),
  spent: true,
};

export const changeNote: OwnedNote = {
  id: `${SPEND_TX}:orchard:${'c2'.repeat(32)}`,
  txid: SPEND_TX,
  height: SPEND_HEIGHT,
  time: SPEND_TIME,
  zat: 1_030_000n,
  memo: '',
  pool: 'orchard',
  kind: 'change',
  nullifier: 'a2'.repeat(32),
  spent: false,
};

export const deposit: OutgoingPayment = {
  id: `${SPEND_TX}:transparent`,
  txid: SPEND_TX,
  height: SPEND_HEIGHT,
  time: SPEND_TIME,
  zat: 930_000n,
  memo: '',
  pool: 'transparent',
};

export const spendFee: FeeRecord = { txid: SPEND_TX, zat: 15_000n, height: SPEND_HEIGHT };

/** 0.0093 ZEC became 11.020977 USDC on HyperCore, which counts USDC in eight decimals. */
export const marginSwap: SwapRecord = {
  id: SWAP_ID,
  purpose: 'margin',
  originAsset: ZEC_ID,
  destinationAsset: USDC_HYPERCORE_ID,
  amountIn: 930_000n,
  minAmountOut: 1_091_000_000n,
  amountOut: 1_102_097_700n,
  depositAddress: DEPOSIT_ADDRESS,
  recipient: HL_ACCOUNT,
  state: 'SUCCESS',
  originTxs: [SPEND_TX],
  destinationTxs: [ARRIVAL_TX],
  createdAt: at('2026-10-09T14:01:05Z'),
  updatedAt: ARRIVAL_TIME,
};

export const openShort: HedgeFill = {
  time: FILL_TIME,
  coin: 'ZEC',
  side: 'sell',
  direction: 'Open Short',
  size: 0.01,
  px: 1226.4,
  fee: 0.005518,
  feeToken: 'USDC',
  closedPnlUsd: 0,
  oid: OID,
  cloid: CLOID,
  tid: '318274650912345',
};

export const fundingPayments: FundingPayment[] = [
  { time: at('2026-10-09T15:00:00.012Z'), coin: 'ZEC', usd: 0.000153, size: -0.01, fundingRate: 0.0000125 },
  { time: at('2026-10-09T16:00:00.048Z'), coin: 'ZEC', usd: 0.000154, size: -0.01, fundingRate: 0.0000125 },
];

export const prices: PricePoint[] = [
  { ts: at('2026-10-09T10:00:00Z'), px: 1219.5 },
  { ts: at('2026-10-09T14:00:00Z'), px: 1225.2 },
  { ts: at('2026-10-09T15:00:00Z'), px: 1226.9 },
  { ts: at('2026-10-09T16:00:00Z'), px: 1228.3 },
];

interface Tick {
  at: number;
  /** Treasury balance the scan found, and the block it reached; null when the chain could not be read. */
  treasury: { zat: bigint; scannedTo: number } | null;
  venue: { markPx: number; shortLots: number; equity: number } | null;
  /** How the venue answered the order this tick placed, if it placed one. */
  fill?: { cloid: Hex; result: OrderResult };
}

/**
 * Journal entries as the engine writes them: the decision comes from the
 * controller itself, and each entry carries the digest of the one before.
 */
export function journalOf(ticks: readonly Tick[], policy: Policy = POLICY, orgId: string = ORG): JournalEntry[] {
  let prev: Hex = ZERO_ROOT;
  return ticks.map((tick, index) => {
    const seq = index + 1;
    const snapshot: JournalEntry['snapshot'] = {
      now: tick.at,
      treasury: tick.treasury === null ? null : { zat: tick.treasury.zat, asOf: tick.at },
      hl:
        tick.venue === null
          ? null
          : {
              asOf: tick.at,
              markPx: tick.venue.markPx,
              oraclePx: tick.venue.markPx,
              shortLots: tick.venue.shortLots,
              accountValueUsd: tick.venue.equity,
              fundingAprBps: 1_095,
            },
      ref: tick.venue === null ? null : { px: tick.venue.markPx, asOf: tick.at },
    };
    const decision = decide(snapshot, policy);
    const action: Action | undefined = decision.actions[0];
    const order: OrderRecord | null =
      action === undefined || tick.fill === undefined
        ? null
        : {
            seq,
            cloid: tick.fill.cloid,
            side: action.kind === 'increaseShort' ? 'sell' : 'buy',
            lots: action.lots,
            limitPx: action.limitPx,
            reduceOnly: action.kind === 'reduceShort',
            result: tick.fill.result,
          };
    const body = {
      orgId,
      seq,
      at: tick.at,
      snapshot,
      policyDigest: digest(policy),
      decision,
      advisories: advise(snapshot, policy),
      order,
      errors: [
        ...(tick.treasury === null ? [{ source: 'treasury' as const, message: 'lightwalletd unreachable' }] : []),
        ...(tick.venue === null ? [{ source: 'venue' as const, message: 'venue timeout' }] : []),
      ],
      scan: tick.treasury === null ? null : { from: BIRTHDAY, to: tick.treasury.scannedTo, tip: tick.treasury.scannedTo, caughtUp: true },
    };
    const entry: JournalEntry = { ...body, prev, digest: digest({ prev, body }) };
    prev = entry.digest;
    return entry;
  });
}

const EQUITY_AFTER_SWAP = 11.020977;
/** Margin less the trade fee, marked at each tick's price against the 1226.4 entry. */
const equityAt = (markPx: number) => EQUITY_AFTER_SWAP - 0.005518 + 0.01 * (1226.4 - markPx);

export const realTicks: Tick[] = [
  // The grant has arrived; there is no margin yet, so nothing is opened.
  { at: at('2026-10-09T10:15:00Z'), treasury: { zat: 1_975_000n, scannedTo: RECEIPT_HEIGHT + 2 }, venue: { markPx: 1219.8, shortLots: 0, equity: 0 } },
  // The deposit has left and the swap is on its way.
  { at: at('2026-10-09T14:05:00Z'), treasury: { zat: 1_030_000n, scannedTo: SPEND_HEIGHT + 1 }, venue: { markPx: 1225.6, shortLots: 0, equity: 0 } },
  // Margin is there: the controller sells one lot.
  {
    at: at('2026-10-09T14:20:00Z'),
    treasury: { zat: 1_030_000n, scannedTo: SPEND_HEIGHT + 13 },
    venue: { markPx: 1227.1, shortLots: 0, equity: EQUITY_AFTER_SWAP },
    fill: { cloid: CLOID, result: { ok: true, filledLots: 1, avgPx: 1226.4, oid: OID, error: null } },
  },
  { at: at('2026-10-09T14:21:00Z'), treasury: { zat: 1_030_000n, scannedTo: SPEND_HEIGHT + 14 }, venue: { markPx: 1227.0, shortLots: 1, equity: equityAt(1227.0) } },
  { at: at('2026-10-09T16:30:00Z'), treasury: { zat: 1_030_000n, scannedTo: SPEND_HEIGHT + 117 }, venue: { markPx: 1228.6, shortLots: 1, equity: equityAt(1228.6) + 0.000307 } },
];

export interface History {
  records: Required<Pick<LedgerInput, 'notes' | 'outgoing' | 'fees' | 'fills' | 'funding' | 'swaps' | 'payoutRuns' | 'prices'>> & { assets: AssetDirectory };
  journal: JournalEntry[];
  payouts: PayoutEvidence[];
}

export function realHistory(): History {
  return {
    records: {
      notes: [receiptNote, changeNote],
      outgoing: [deposit],
      fees: [spendFee],
      fills: [openShort],
      funding: fundingPayments,
      swaps: [marginSwap],
      payoutRuns: [],
      prices,
      assets: {},
    },
    journal: journalOf(realTicks),
    payouts: [],
  };
}

export const TEMPO_PATH_USD = '0x20c0000000000000000000000000000000000000';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const payoutAssets: AssetDirectory = {
  [TEMPO_PATH_USD]: { symbol: 'pathUSD', decimals: 6, chain: 'tempo', usdPegged: true },
  [SOLANA_USDC_MINT]: { symbol: 'USDC', decimals: 6, chain: 'solana', usdPegged: true },
};

const ADA_TEMPO = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const KOFI_TEMPO = '0x2546BcD3c84621e976D8185a91A922aE77ECEc30';
const ADA_SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ADA_SOLANA_TOKEN_ACCOUNT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export const FLOAT_SPEND_TX = '9e3fa1c07b5d4e8892aa60c1d3f47b0e5a6c8d91f2037b4c6e5d8a9f0b1c2d3e';
export const FLOAT_ARRIVAL_TX = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
export const TEMPO_RUN_TX = '0x4f1b6c2d9e8a7b3c5d6e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e';
export const SOLANA_RUN_TX = '3Nq8mXz1rT5vK9pL2cW7yB4dF6hJ8gA1sE3uR5iO7nM9bV2xC4zQ6wY8tP1kD3fH5jL7aS9gU2eI4oR6';

export const tempoRun: PayoutRunRecord = {
  id: 'HF-2026-10-0001',
  chain: 'tempo',
  token: TEMPO_PATH_USD,
  status: 'paid',
  total: 750_000_000n,
  tx: TEMPO_RUN_TX,
  createdAt: at('2026-10-20T09:00:00Z'),
  executedAt: at('2026-10-20T09:02:11Z'),
  lines: [
    { lineNo: 1, payeeName: 'Ada Reyes', toAddress: ADA_TEMPO, amount: 450_000_000n, memo: 'HF-2026-10-0001/1', tx: TEMPO_RUN_TX, logIndex: 4 },
    { lineNo: 2, payeeName: 'Kofi Mensah', toAddress: KOFI_TEMPO, amount: 300_000_000n, memo: 'HF-2026-10-0001/2', tx: TEMPO_RUN_TX, logIndex: 5 },
  ],
};

export const solanaRun: PayoutRunRecord = {
  id: 'HF-2026-11-0001',
  chain: 'solana',
  token: SOLANA_USDC_MINT,
  status: 'paid',
  total: 125_500_000n,
  tx: SOLANA_RUN_TX,
  createdAt: at('2026-11-03T12:00:00Z'),
  executedAt: at('2026-11-03T12:00:40Z'),
  lines: [{ lineNo: 1, payeeName: 'Ada Reyes', toAddress: ADA_SOLANA, amount: 125_500_000n, memo: 'October retainer', tx: SOLANA_RUN_TX, logIndex: null }],
};

export const payoutEvidence: PayoutEvidence[] = [
  {
    run: tempoRun,
    onChain: {
      tx: TEMPO_RUN_TX,
      transfers: [
        { to: ADA_TEMPO.toLowerCase(), tokenAccount: null, amount: 450_000_000n, memo: 'HF-2026-10-0001/1' },
        { to: KOFI_TEMPO, tokenAccount: null, amount: 300_000_000n, memo: 'HF-2026-10-0001/2' },
      ],
      otherTxs: [],
    },
  },
  {
    run: solanaRun,
    onChain: {
      tx: SOLANA_RUN_TX,
      transfers: [{ to: ADA_SOLANA, tokenAccount: ADA_SOLANA_TOKEN_ACCOUNT, amount: 125_500_000n, memo: 'October retainer' }],
      otherTxs: [],
    },
  },
];

const secondReceipt: OwnedNote = {
  id: `${'5a'.repeat(32)}:orchard:${'c3'.repeat(32)}`,
  txid: '5a'.repeat(32),
  height: SPEND_HEIGHT + 4_000,
  time: at('2026-10-14T08:30:00Z'),
  zat: 250_000_000n,
  memo: 'ZCG grant, milestone 3 of 4.',
  pool: 'orchard',
  kind: 'incoming',
  nullifier: 'a3'.repeat(32),
  spent: true,
};

const floatChange: OwnedNote = {
  id: `${FLOAT_SPEND_TX}:orchard:${'c4'.repeat(32)}`,
  txid: FLOAT_SPEND_TX,
  height: SPEND_HEIGHT + 4_800,
  time: at('2026-10-15T09:10:00Z'),
  zat: 149_990_000n,
  memo: '',
  pool: 'orchard',
  kind: 'change',
  nullifier: 'a4'.repeat(32),
  spent: false,
};

const floatDeposit: OutgoingPayment = {
  id: `${FLOAT_SPEND_TX}:transparent`,
  txid: FLOAT_SPEND_TX,
  height: floatChange.height,
  time: floatChange.time,
  zat: 100_000_000n,
  memo: '',
  pool: 'transparent',
};

export const floatSwap: SwapRecord = {
  id: '41c9a7d2-8e05-4f6b-b3a1-7d2e9c0f5a68',
  purpose: 'payout_float',
  originAsset: ZEC_ID,
  destinationAsset: USDC_SOLANA_ID,
  amountIn: 100_000_000n,
  minAmountOut: 1_190_000_000n,
  amountOut: 1_201_350_000n,
  depositAddress: 't1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs',
  recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  state: 'SUCCESS',
  originTxs: [FLOAT_SPEND_TX],
  destinationTxs: [FLOAT_ARRIVAL_TX],
  createdAt: at('2026-10-15T09:05:00Z'),
  updatedAt: at('2026-10-15T09:19:30Z'),
};

/** The real first day, followed by a made-up month: a second grant, a swap into payout float and two payout runs. */
export function historyWithPayouts(): History {
  const real = realHistory();
  return {
    records: {
      ...real.records,
      notes: [...real.records.notes, secondReceipt, floatChange],
      outgoing: [...real.records.outgoing, floatDeposit],
      fees: [...real.records.fees, { txid: FLOAT_SPEND_TX, zat: 10_000n, height: floatChange.height }],
      swaps: [...real.records.swaps, floatSwap],
      payoutRuns: [tempoRun, solanaRun],
      prices: [...prices, { ts: at('2026-10-14T08:00:00Z'), px: 1210.0 }, { ts: at('2026-10-15T09:00:00Z'), px: 1214.5 }],
      assets: payoutAssets,
    },
    journal: real.journal,
    payouts: payoutEvidence,
  };
}
