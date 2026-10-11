import type { PayoutChain, PayoutRunRow } from '@holdfast/db';
import type { Deps } from '../deps';
import { notFound } from '../errors';

/**
 * What a payee is shown for one payout line: the payment and where to check
 * it on its chain. Nothing here says who paid, from which account, or what
 * else was paid in the same run.
 */
export interface Receipt {
  chain: PayoutChain;
  token: { address: string; symbol: string | null; decimals: number | null };
  /** Token base units. */
  amount: bigint;
  /** What the transfer carries on chain. */
  memo: string;
  tx: string;
  txUrl: string;
}

export function txUrlOf(deps: Pick<Deps, 'tempo' | 'solana'>, chain: PayoutChain, tx: string): string {
  return chain === 'tempo' ? deps.tempo.txUrl(tx) : deps.solana.txUrl(tx);
}

export function tokenOf(run: Pick<PayoutRunRow, 'token' | 'tokenSymbol' | 'tokenDecimals'>): Receipt['token'] {
  return { address: run.token, symbol: run.tokenSymbol, decimals: run.tokenDecimals };
}

/**
 * The receipt behind a token. There is one only for a line that was paid: a
 * token of a run that is not paid answers like a token nobody was given.
 */
export async function receiptOf(deps: Pick<Deps, 'store' | 'tempo' | 'solana'>, token: string): Promise<Receipt> {
  const found = await deps.store.findReceipt(token);
  if (found === null || found.run.status !== 'paid') throw notFound();
  const tx = found.line.tx ?? found.run.tx;
  if (tx === null) throw notFound();
  return {
    chain: found.run.chain,
    token: tokenOf(found.run),
    amount: found.line.amount,
    memo: found.line.memo,
    tx,
    txUrl: txUrlOf(deps, found.run.chain, tx),
  };
}
