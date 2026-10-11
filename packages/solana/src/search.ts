import {
  decodeTransactionFromRpcResponse,
  getAccountMetasFromCompiledTransactionMessage,
  getInstructionsFromCompiledTransactionMessage,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  type Address,
  type ResolvedInstruction,
  type Signature,
} from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import type { SettledCommitment, SolanaRpc } from './connection';
import { describeFailure } from './errors';
import { leadingSignatureMemo } from './memo';
import { readRun, type PayoutRun, type RunIdentity } from './reconcile';

/** What a search already learned about a transaction, so that it is not fetched again. */
export interface KnownTransaction {
  failed: boolean;
  /** Its first memo, null when it has none. */
  leadingMemo: string | null;
  /** Whether the team token account did not exist before it. */
  createdSource: boolean;
}

export interface RunSearch {
  /** How settled a run must be to count as paid. */
  commitment: SettledCommitment;
  /**
   * A slot before which the run cannot have been paid, for instance one
   * recorded when the run was created. The search stops there instead of
   * reading the account's history to its beginning.
   */
  notBefore?: bigint;
  /** Transactions earlier searches have read, keyed by {@link knownKey}. */
  known?: Map<string, KnownTransaction>;
  /** How many transactions the search may fetch before it gives up proving anything. Defaults to 50. */
  maxInspections?: number;
}

export interface FoundRun {
  run: PayoutRun;
  /** False while the run is on chain but has not reached the commitment asked for. */
  settled: boolean;
}

/**
 * The history could not show that a run is unpaid. That is a different
 * answer from "not paid", and a caller about to send money must treat it as
 * a reason not to.
 */
export class UnprovenAbsence extends Error {}

const SIGNATURE_PAGE = 1_000;
const MAX_SIGNATURE_PAGES = 10;
const DEFAULT_MAX_INSPECTIONS = 50;
/** `getSignaturesForAddress` serves nothing below this, so a payment can only be looked for here. */
const HISTORY_COMMITMENT = 'confirmed';

export const knownKey = (source: Address, signature: string): string => `${source}:${signature}`;

interface Inspection extends KnownTransaction {
  run: PayoutRun | null;
}

type TransactionMeta = NonNullable<
  NonNullable<Awaited<ReturnType<ReturnType<SolanaRpc['getTransaction']>['send']>>>['meta']
>;

/** Base units of the token that left an account in a transaction; null when the node kept no record. */
function tokensSpent(meta: TransactionMeta, accountIndex: number): bigint | null {
  if (!meta.preTokenBalances || !meta.postTokenBalances) return null;
  const amountIn = (balances: NonNullable<TransactionMeta['preTokenBalances']>): bigint => {
    const balance = balances.find(entry => Number(entry.accountIndex) === accountIndex);
    return balance ? BigInt(balance.uiTokenAmount.amount) : 0n;
  };
  return amountIn(meta.preTokenBalances) - amountIn(meta.postTokenBalances);
}

/**
 * Fetch a transaction from the history of the team's token account and say
 * what it is. A transaction that the node lists but will not return, or one
 * that cannot be read, may be the payment being looked for: both throw.
 */
async function inspect(rpc: SolanaRpc, signature: Signature, run: RunIdentity): Promise<Inspection> {
  const response = await rpc
    .getTransaction(signature, {
      commitment: HISTORY_COMMITMENT,
      encoding: 'base64',
      maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
    })
    .send();
  if (!response?.meta) {
    throw new UnprovenAbsence(`the node lists transaction ${signature} for ${run.source} but does not return it`);
  }
  const { meta } = response;

  let instructions: ResolvedInstruction[];
  let accounts: Address[];
  try {
    const { compiledMessage, loadedAddresses } = decodeTransactionFromRpcResponse(response);
    instructions = getInstructionsFromCompiledTransactionMessage(compiledMessage, loadedAddresses);
    accounts = getAccountMetasFromCompiledTransactionMessage(compiledMessage, loadedAddresses).map(
      account => account.address,
    );
  } catch (error) {
    throw new UnprovenAbsence(`transaction ${signature} could not be decoded (${describeFailure(error)})`);
  }

  const sourceIndex = accounts.indexOf(run.source);
  const lamportsBefore = meta.preBalances[sourceIndex];
  const createdSource = lamportsBefore !== undefined && Number(lamportsBefore) === 0;
  const [leadingMemo = null] = getMemosFromInstructions(instructions).map(({ memo }) => memo);
  const known = { failed: meta.err !== null, leadingMemo, createdSource };
  if (known.failed) return { ...known, run: null };

  const transfers = readRun(instructions, run);
  if (transfers === null) return { ...known, run: null };

  // The instructions are one account of what happened and the token balances
  // are another. If more tokens left the account than the instructions show,
  // through another program for instance, the run was paid in a form that
  // cannot be compared with a request. Tokens arriving are nobody's payment:
  // anyone can send some along with any memo.
  const spent = tokensSpent(meta, sourceIndex);
  const explained = transfers.reduce((sum, transfer) => sum + transfer.amount, 0n);
  if (spent === null || spent > explained) {
    throw new UnprovenAbsence(
      `transaction ${signature} carries run ${run.runId} as its memo, but what it moved out of ${run.source} ` +
        'cannot be read from its instructions',
    );
  }
  if (transfers.length === 0) return { ...known, run: null };

  // The instruction names the credited token account; the wallet behind it is
  // only recorded in the transaction's token balance metadata.
  const walletOf = new Map<Address, Address>();
  for (const balance of meta.postTokenBalances ?? []) {
    const tokenAccount = accounts[Number(balance.accountIndex)];
    if (tokenAccount && balance.owner) walletOf.set(tokenAccount, balance.owner);
  }
  return {
    ...known,
    run: {
      runId: run.runId,
      signature,
      slot: response.slot,
      time: response.blockTime === null ? null : Number(response.blockTime) * 1_000,
      total: explained,
      transfers: transfers.map(transfer => {
        const to = walletOf.get(transfer.tokenAccount);
        if (!to) {
          throw new UnprovenAbsence(`transaction ${signature} has no token balance record for ${transfer.tokenAccount}`);
        }
        return { to, tokenAccount: transfer.tokenAccount, amount: transfer.amount, memo: transfer.memo };
      }),
    },
  };
}

async function isFinalized(rpc: SolanaRpc, signature: Signature): Promise<boolean> {
  const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send();
  return value[0]?.confirmationStatus === 'finalized';
}

/**
 * Look for a paid run in the history of the team's token account.
 *
 * Returns the run, or null when the history proves there is none. It never
 * returns null merely because it found nothing: whenever the search cannot
 * account for every transaction that might be the payment, it throws
 * {@link UnprovenAbsence}. A null therefore rests on all of the following.
 *
 * - The listing was read down to `notBefore`, or else to the transaction
 *   that created the account. A listing that stops short, at the page limit
 *   or because the node has pruned what lies below, proves nothing.
 * - Every listed transaction that succeeded was either shown by the node to
 *   lead with a different memo, or fetched and read. A null memo field is
 *   not taken as "no memo": a node that does not index the Memo program in
 *   use reports null for a payment too. A field that does parse is taken at
 *   its word, because a payout writes all its memos through one program, so
 *   a node reports either all of them or none.
 * - Every transaction that had to be fetched was returned and decoded.
 *
 * The history is read at `confirmed`, the weakest commitment the node serves
 * it at, whatever commitment the caller settles at: a payment that has only
 * been confirmed exists, and is reported as found but not yet settled.
 *
 * What no reading of history can show is a payment that is still on its way
 * or that this node has not caught up with.
 */
export async function searchRun(rpc: SolanaRpc, run: RunIdentity, search: RunSearch): Promise<FoundRun | null> {
  const { notBefore, known } = search;
  const { source, runId } = run;
  const maxInspections = search.maxInspections ?? DEFAULT_MAX_INSPECTIONS;
  let inspections = 0;
  const read = async (signature: Signature): Promise<Inspection> => {
    if (++inspections > maxInspections) {
      throw new UnprovenAbsence(
        `more than ${maxInspections} transactions of ${source} would have to be read to rule run ${runId} out; ` +
          'pass notBefore to bound the search',
      );
    }
    const inspection = await inspect(rpc, signature, run);
    const { failed, leadingMemo, createdSource } = inspection;
    known?.set(knownKey(source, signature), { failed, leadingMemo, createdSource });
    return inspection;
  };

  let before: Signature | undefined;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const entries = await rpc
      .getSignaturesForAddress(source, {
        commitment: HISTORY_COMMITMENT,
        limit: SIGNATURE_PAGE,
        ...(before ? { before } : {}),
      })
      .send();

    for (const entry of entries) {
      // Entries come newest first, so everything from here on is older still.
      if (notBefore !== undefined && entry.slot < notBefore) return null;
      before = entry.signature;
      // Only an error the node actually reports makes a transaction a failure.
      if (entry.err !== null && entry.err !== undefined) continue;
      const leadingMemo = leadingSignatureMemo(entry.memo);
      if (leadingMemo !== null && leadingMemo !== runId) continue;
      const seen = known?.get(knownKey(source, entry.signature));
      if (seen && (seen.failed || seen.leadingMemo !== runId)) continue;

      const { run: found } = await read(entry.signature);
      if (!found) continue;
      const settled =
        search.commitment === HISTORY_COMMITMENT ||
        entry.confirmationStatus === 'finalized' ||
        (await isFinalized(rpc, entry.signature));
      return { run: found, settled };
    }

    if (entries.length === SIGNATURE_PAGE) continue;
    // The listing has ended. Whether that is the end of the account's history
    // or only of what this node keeps is the question.
    if (notBefore !== undefined) {
      const floor = await rpc.getFirstAvailableBlock().send();
      if (floor <= notBefore) return null;
      throw new UnprovenAbsence(
        `the node's history begins at slot ${floor}, after slot ${notBefore} from which run ${runId} could exist`,
      );
    }
    if (!before) throw new UnprovenAbsence(`the node has no history for ${source}`);
    const origin = known?.get(knownKey(source, before)) ?? (await read(before));
    if (origin.createdSource) return null;
    throw new UnprovenAbsence(
      `the node's history of ${source} does not reach back to its creation; pass notBefore to bound the search`,
    );
  }
  throw new UnprovenAbsence(
    `${source} has more than ${SIGNATURE_PAGE * MAX_SIGNATURE_PAGES} transactions` +
      `${notBefore === undefined ? '' : ` since slot ${notBefore}`}; run ${runId} cannot be ruled out` +
      `${notBefore === undefined ? ', pass notBefore to bound the search' : ''}`,
  );
}
