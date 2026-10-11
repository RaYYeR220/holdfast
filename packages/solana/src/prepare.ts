import type { PayoutLine } from '@holdfast/core';
import { isAddress, type Address, type KeyPairSigner } from '@solana/kit';
import { AccountState } from '@solana-program/token';
import { associatedTokenAddress, delegatedAllowance, fetchTokenAccount } from './accounts';
import { formatBaseUnits } from './amounts';
import { payoutTransactionSize, TRANSACTION_SIZE_LIMIT } from './capacity';
import type { RailContext } from './context';
import { lamportsShort, payoutCost, type PayoutCost } from './cost';
import { markerShortfall, runMarker, runMarkerSeed, type RunMarker } from './marker';
import { identifyPayees, resolveTransfers, type Payee } from './payees';
import { fitsOneTransaction, payoutShape, type PayoutPlan } from './payout';

export interface RunInput {
  account: string;
  lines: PayoutLine[];
  runId: string;
  /**
   * A slot before which this run cannot have been paid, such as the one
   * `checkpoint()` returned when the run was created. It bounds the reading
   * of the paying account's history, which is how a payment is described
   * and how one made without a run marker is noticed.
   */
  notBefore?: bigint;
}

/** A run as asked for, checked and resolved as far as that goes without the node. */
export interface RunRequest {
  runId: string;
  signer: KeyPairSigner;
  /** The team's token account. */
  source: Address;
  payees: Payee[];
  /** The marker this run is paid under by the service key in use. */
  marker: RunMarker;
  /** The markers the same run would have under service keys that were in use before. */
  earlierMarkers: RunMarker[];
  notBefore?: bigint;
}

/** A run that may be sent, or the reason it may not, with its cost where that got worked out. */
export type Prepared = { plan: PayoutPlan; cost: PayoutCost } | { error: string; cost: PayoutCost | null };

/** Returns what is wrong with the run when it cannot be paid as written. */
export async function identifyRun(context: RailContext, i: RunInput): Promise<RunRequest | string> {
  if (!isAddress(i.account)) return `"${i.account}" is not a Solana address`;
  const signer = await context.delegate();
  const source = await associatedTokenAddress(i.account, context.mint);
  const payees = await identifyPayees(i.lines, i.runId, context.mint, source);
  if (typeof payees === 'string') return payees;
  if (i.notBefore !== undefined && i.notBefore < 0n) return `invalid notBefore ${i.notBefore}`;

  const seed = await runMarkerSeed(i.account, context.mint, i.runId);
  return {
    runId: i.runId,
    signer,
    source,
    payees,
    marker: await runMarker(signer.address, seed),
    earlierMarkers: await Promise.all(context.previousDelegates.map(delegate => runMarker(delegate, seed))),
    ...(i.notBefore === undefined ? {} : { notBefore: i.notBefore }),
  };
}

/**
 * Every check between knowing a run is new and sending it: the allowance and
 * the balance it draws on, the payees, the SOL it costs the service key, and
 * whether it fits one transaction. Sends nothing. `markerLamports` is what
 * the marker's address already holds.
 */
export async function prepareRun(context: RailContext, request: RunRequest, markerLamports: bigint): Promise<Prepared> {
  const { rpc, mint, decimals, commitment } = context;
  const { runId, signer, source, payees, marker } = request;
  const format = (units: bigint): string => formatBaseUnits(units, decimals);

  const token = await fetchTokenAccount(rpc, source, commitment);
  const allowance = delegatedAllowance(token, signer.address);
  const total = payees.reduce((sum, payee) => sum + payee.amount, 0n);
  if (total > allowance) {
    const error = `exceeds delegated allowance: run needs ${format(total)}, ${format(allowance)} remaining`;
    return { error, cost: null };
  }
  if (token?.state === AccountState.Frozen) return { error: 'the paying token account is frozen', cost: null };
  if (token && total > token.amount) {
    const error = `insufficient token balance: run needs ${format(total)}, account holds ${format(token.amount)}`;
    return { error, cost: null };
  }

  const transfers = await resolveTransfers(rpc, commitment, payees);
  if (typeof transfers === 'string') return { error: transfers, cost: null };

  const rates = await context.rent();
  const created = transfers.filter(transfer => transfer.createTokenAccount).length;
  const cost = payoutCost(created, markerShortfall(markerLamports, rates.marker), rates);
  if (cost.newTokenAccounts > context.maxNewTokenAccounts) {
    const error =
      `run would create ${cost.newTokenAccounts} payee token accounts at the service key's expense ` +
      `(${cost.rentLamports} lamports of rent), the limit is ${context.maxNewTokenAccounts} per run`;
    return { error, cost };
  }
  const { value: balance } = await rpc.getBalance(signer.address, { commitment }).send();
  const short = lamportsShort(balance, cost, rates);
  if (short > 0n) {
    const error =
      `the service key ${signer.address} is ${short} lamports short: the run needs ${cost.rentLamports} ` +
      `for token account rent, ${cost.markerLamports} for its run marker and ${cost.feeLamports} for the fee ` +
      `on top of the ${rates.wallet} the key must keep, and it holds ${balance}`;
    return { error, cost };
  }

  const withoutLineMemos: PayoutPlan = {
    delegate: signer,
    source,
    mint,
    decimals,
    runId,
    marker,
    markerLamports: cost.markerLamports,
    transfers,
    lineMemos: false,
  };
  const candidates = payees.some(payee => payee.memo !== '')
    ? [{ ...withoutLineMemos, lineMemos: true }, withoutLineMemos]
    : [withoutLineMemos];
  const plan = candidates.find(fitsOneTransaction);
  if (!plan) {
    const error =
      `run does not fit in one transaction: ${payees.length} lines need about ` +
      `${payoutTransactionSize(payoutShape(withoutLineMemos))} bytes even without line memos, ` +
      `the limit is ${TRANSACTION_SIZE_LIMIT}; split it into smaller runs`;
    return { error, cost };
  }
  return { plan, cost };
}
