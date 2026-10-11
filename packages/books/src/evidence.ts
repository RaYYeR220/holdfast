import type { PayoutRunRecord } from './records';

/** One transfer of a payout run, read back from its chain. */
export interface OnChainTransfer {
  /** The payee as the chain names them: the address on Tempo, the wallet on Solana. */
  to: string;
  /** The token account that was credited, on chains that have one. */
  tokenAccount: string | null;
  amount: bigint;
  /** Null when the transfer carries no memo of its own. */
  memo: string | null;
}

/** What a rail's `findRun` found for a run, in one shape for both chains. */
export interface OnChainRun {
  tx: string;
  transfers: OnChainTransfer[];
  /** Further transactions carrying the run's memos; any means lines were paid more than once. */
  otherTxs: string[];
}

/** A run as the database holds it, beside what its chain shows; null when the chain shows nothing. */
export interface PayoutEvidence {
  run: PayoutRunRecord;
  onChain: OnChainRun | null;
}

/** From the result of the Tempo rail's `findRun`. */
export function tempoRunOnChain(
  found: { tx: string; lines: readonly { to: string; amount: bigint; memo: string }[]; otherTxs: readonly string[] } | null,
): OnChainRun | null {
  if (found === null) return null;
  return {
    tx: found.tx,
    transfers: found.lines.map((line) => ({ to: line.to, tokenAccount: null, amount: line.amount, memo: line.memo })),
    otherTxs: [...found.otherTxs],
  };
}

/** From the result of the Solana rail's `findRun`, which reads one transaction and so has no others to report. */
export function solanaRunOnChain(
  found: {
    signature: string;
    transfers: readonly { to: string; tokenAccount: string; amount: bigint; memo: string | null }[];
  } | null,
): OnChainRun | null {
  if (found === null) return null;
  return {
    tx: found.signature,
    transfers: found.transfers.map((t) => ({ to: t.to, tokenAccount: t.tokenAccount, amount: t.amount, memo: t.memo })),
    otherTxs: [],
  };
}
