import type { PayoutAllowance, PayoutLine } from '@holdfast/core';
import type { KeyAuthorization } from 'ox/tempo';
import { type Address, type Hex, getAddress, isAddress, isAddressEqual, maxUint256 } from 'viem';
import { verifySignedAuthorization } from './authorization';
import type { ChainHead, ChainReceipt, SignedTx, TempoChain } from './chain';
import { TempoRailError, resolveConfig } from './config';
import { allowsRecipient, differencesFromAuthorization, grantedStatus, toKeyStatus } from './key-status';
import { memoBytes, runIdProblem, runMemos } from './memo';
import { TX_VALIDITY_SECONDS, feeCeiling, gasCeiling, keyProblems, lineProblems, payoutProblems } from './preflight';
import type { PayoutFacts } from './preflight';
import { decodeRevertReason, explainError } from './reasons';
import { keyAuthorizedIn, runLines, sameLines, verifyPayoutLogs } from './receipt';
import { type Call, transferCall, transferWithMemoCall } from './tip20';
import type {
  FindRunOptions,
  KeyStatus,
  PreflightResult,
  ProbeResult,
  RunOnChain,
  SubmitAuthorizationInput,
  TempoPayoutRail,
  TempoPayoutResult,
  TempoRailConfig,
} from './types';
import { createViemChain } from './viem-chain';

export interface RailDeps {
  /** Replaces the RPC-backed chain access, for tests. */
  chain?: TempoChain;
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock in ms. */
  clock?: () => number;
}

const POLL_MS = 500;
/** How long past the validity window the rail keeps asking before it calls the outcome unknown. */
const SETTLE_GRACE_SECONDS = 30;
/** Gas given to a probe. Nothing can be estimated for a transaction that is meant to fail. */
const PROBE_GAS = 1_000_000n;
const KEY_AUTHORIZED_MEMO = 'HF-KEY-AUTHORIZED';
const OVER_LIMIT_MEMO = 'HF-PROBE-OVER-LIMIT';

type Outcome = { kind: 'included'; receipt: ChainReceipt } | { kind: 'expired' } | { kind: 'unknown'; detail: string | null };
type Launch = { kind: 'rejected'; reason: string } | (Outcome & { unreachable: string | null });

interface Send {
  root: Address;
  lines: readonly PayoutLine[];
  /** Null for a transaction that only provisions the key. */
  runId: string | null;
  nonce: number;
  keyAuthorization?: KeyAuthorization.Signed;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function refused(error: string, tx: Hex | null = null, gasUsed: bigint | null = null): TempoPayoutResult {
  return { ok: false, tx, error, alreadyPaid: false, gasUsed };
}

/**
 * The transaction that provisions a key needs one call the new key may make.
 * Without a first run that is a transfer of zero: to the account itself, or to
 * the first payee when only listed payees are allowed.
 */
function carrier(to: Address): PayoutLine {
  return { to, amount: 0n, memo: KEY_AUTHORIZED_MEMO };
}

function noReceipt(error: string, tx: Hex | null = null): ProbeResult {
  return { tx, includedOnChain: false, reverted: false, reason: null, returnData: null, gasUsed: null, error };
}

/** Runs tasks one after another: the rail is the only writer on its nonce lane, and two sends must not share a nonce. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Stablecoin payouts on Tempo from an account the service does not control.
 *
 * The service holds a P-256 access key the account's root authorized with an
 * expiry, a spending limit and a call scope; the Account Keychain precompile
 * enforces all three. A run is one transaction with one `transferWithMemo`
 * per line, signed by the access key, with fees paid by a separate sponsor so
 * that the key's limit is spent on payouts and nothing else.
 *
 * The rail pays only with a key that is bounded on chain the way it expects:
 * a spending limit, and a call scope of `transferWithMemo` on the payout token
 * alone. A key the keychain lists with anything broader counts as not
 * authorized, whatever the rail was configured with.
 *
 * The run id reaches the chain through the memos: every line's memo must be
 * `<runId>/<line>` with a line from 1 to 32 (`lineMemo` builds it), and the
 * token emits the memo as an indexed event topic. A run can therefore carry
 * only 32 different memos, `findRun` searches for all of them, and that is
 * what makes `pay` safe to repeat for the same run id.
 *
 * Nothing is sent on the strength of a read that failed or may be out of
 * date. The search for an earlier payment either covers every block up to the
 * one the nonce was read at or fails; a transaction is called expired only on
 * a nonce read pinned to a block whose time is past its deadline.
 */
export function createTempoPayoutRail(config: TempoRailConfig, deps: RailDeps = {}): TempoPayoutRail {
  const settings = resolveConfig(config);
  const { token, accessKey, sponsor } = settings;
  const io = deps.chain ?? createViemChain(settings);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = deps.clock ?? Date.now;
  const exclusive = serialQueue();

  function requireAccount(account: string): Address {
    if (!isAddress(account)) throw new TempoRailError(`account "${account}" is not a valid address`);
    return getAddress(account);
  }

  function accountProblems(account: string): string[] {
    if (!isAddress(account)) return [`account "${account}" is not a valid address`];
    // Fees taken from the paying account would show up as a transfer the run did not ask for.
    if (isAddressEqual(account, sponsor)) return ['the fee sponsor must be a different account from the one paying out'];
    return [];
  }

  function requestProblems(account: string, lines: readonly PayoutLine[], runId?: string): string[] {
    return [...accountProblems(account), ...lineProblems(lines, runId)];
  }

  /** The key as the keychain holds it for `root`: a key authorized on some other account reads as unknown here. */
  async function status(root: Address): Promise<{ key: KeyStatus; head: ChainHead }> {
    const [raw, head] = await Promise.all([io.keyState(root), io.head()]);
    return { key: toKeyStatus(raw, accessKey, token, head.timestamp), head };
  }

  /** `granted` stands in for the key while it is not provisioned yet; it is evaluated at the time that is read here. */
  async function facts(root: Address, gas: bigint, granted?: (now: number) => KeyStatus): Promise<PayoutFacts> {
    const [current, rootBalance, sponsorBalance] = await Promise.all([status(root), io.balanceOf(token, root), io.balanceOf(settings.feeToken, sponsor)]);
    const now = current.head.timestamp;
    return { now, key: granted ? granted(now) : current.key, rootBalance, sponsorBalance, feeCeiling: feeCeiling(gas, current.head.baseFeePerGas) };
  }

  async function keyStatus(account: string): Promise<KeyStatus> {
    const root = requireAccount(account);
    await io.assertChain();
    return (await status(root)).key;
  }

  async function remaining(account: string): Promise<PayoutAllowance> {
    const key = await keyStatus(account);
    // The keychain exposes what is left and when the window ends, but not the size of the limit.
    return { remaining: key.remaining, limit: null, resetsAt: key.periodEnd };
  }

  async function preflight(i: { account: string; lines: PayoutLine[]; runId?: string }): Promise<PreflightResult> {
    const invalid = requestProblems(i.account, i.lines, i.runId);
    if (invalid.length > 0) return { ok: false, problems: invalid };
    try {
      await io.assertChain();
      const problems = payoutProblems({ lines: i.lines, sponsor, facts: await facts(getAddress(i.account), gasCeiling(i.lines.length)) });
      return problems.length === 0 ? { ok: true } : { ok: false, problems };
    } catch (error) {
      return { ok: false, problems: [`could not read the chain: ${explainError(error)}`] };
    }
  }

  /** Search the blocks up to `toBlock` for the run. Rejects rather than answer "not found" on a search that was not whole. */
  async function locate(root: Address, runId: string, toBlock: bigint, lookback: bigint): Promise<RunOnChain | null> {
    const fromBlock = toBlock > lookback ? toBlock - lookback : 0n;
    const logs = await io.memoLogs({ root, memos: runMemos(runId).map(memoBytes), fromBlock, toBlock });
    const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    const first = ordered[0];
    if (!first) return null;
    const hashes = [...new Set(ordered.map((log) => log.transactionHash))];
    // Every memo a run can carry was searched for, so the logs in hand already hold all of its lines if the receipt is not served.
    const receipt = await io.receipt(first.transactionHash);
    const source = receipt?.logs ?? ordered.filter((log) => log.transactionHash === first.transactionHash);
    return { tx: first.transactionHash, blockNumber: first.blockNumber, lines: runLines(source, root, token, runId), otherTxs: hashes.slice(1) };
  }

  async function findRun(account: string, runId: string, options: FindRunOptions = {}): Promise<RunOnChain | null> {
    const root = requireAccount(account);
    const problem = runIdProblem(runId);
    if (problem) throw new TempoRailError(problem);
    await io.assertChain();
    return locate(root, runId, (await io.head()).number, options.lookbackBlocks ?? settings.lookbackBlocks);
  }

  /** What the chain already holds for this run id up to `toBlock`, whatever lines it was paid with; null when it holds nothing. */
  async function alreadyOnChain(root: Address, lines: readonly PayoutLine[], runId: string, toBlock: bigint): Promise<TempoPayoutResult | null> {
    const found = await locate(root, runId, toBlock, settings.lookbackBlocks);
    if (!found) return null;
    if (found.otherTxs.length > 0) {
      const all = [found.tx, ...found.otherTxs].join(', ');
      return refused(`run ${runId} is on chain in more than one transaction (${all}); nothing was sent, and the run needs a person to look at it`, found.tx);
    }
    if (sameLines(lines, found.lines)) return { ok: true, tx: found.tx, error: null, alreadyPaid: true, gasUsed: null };
    return refused(`run ${runId} is already on chain in ${found.tx} with different lines; nothing was sent`, found.tx);
  }

  /**
   * Wait until the transaction is in a block or can no longer get into one.
   *
   * "Expired" needs two facts about one and the same block: its timestamp is
   * at or past `validBefore`, so no later block can include the transaction,
   * and the lane's nonce as of that block has not moved, so no block up to it
   * did. The nonce is read pinned to that block; a node that does not have the
   * block refuses the read, and a failed read concludes nothing. Whatever
   * falls short of that is "unknown".
   */
  async function settle(root: Address, hash: Hex, nonce: number, validBefore: number): Promise<Outcome> {
    const giveUpAt = clock() + (TX_VALIDITY_SECONDS + SETTLE_GRACE_SECONDS) * 1000;
    let detail: string | null = null;
    for (;;) {
      try {
        const receipt = await io.receipt(hash);
        if (receipt) return { kind: 'included', receipt };
        const head = await io.head();
        if (head.timestamp >= validBefore) {
          if ((await io.laneNonce(root, head.number)) <= nonce) return { kind: 'expired' };
          detail = 'the nonce was used but the node has no receipt for the transaction';
        } else {
          detail = null;
        }
      } catch (error) {
        detail = explainError(error);
      }
      if (clock() >= giveUpAt) return { kind: 'unknown', detail };
      await sleep(POLL_MS);
    }
  }

  async function launch(root: Address, tx: SignedTx, nonce: number, validBefore: number): Promise<Launch> {
    let unreachable: string | null = null;
    try {
      const sent = await io.broadcast(tx.serialized);
      if (!sent.accepted) return { kind: 'rejected', reason: sent.reason };
    } catch (error) {
      // The node may or may not have the bytes; the receipt or the validity window will tell.
      unreachable = explainError(error);
    }
    return { ...(await settle(root, tx.hash, nonce, validBefore)), unreachable };
  }

  async function send(input: Send): Promise<TempoPayoutResult> {
    const { root, lines, runId, nonce } = input;
    const validBefore = (await io.head()).timestamp + TX_VALIDITY_SECONDS;
    const calls = lines.map((line) => transferWithMemoCall(token, getAddress(line.to), line.amount, line.memo));
    let tx: SignedTx;
    try {
      tx = await io.signPayout({ root, calls, nonce, validBefore, ...(input.keyAuthorization ? { keyAuthorization: input.keyAuthorization } : {}) });
    } catch (error) {
      return refused(`the node refused the transaction before it was sent: ${explainError(error)}`);
    }

    const outcome = await launch(root, tx, nonce, validBefore);
    if (outcome.kind !== 'included' && runId !== null) {
      // This transaction did not make it, but an earlier attempt at the same run may have: it held the same nonce.
      // Nothing is sent after this point, so a search that fails here only costs the better answer.
      const earlier = await io
        .head()
        .then((head) => alreadyOnChain(root, lines, runId, head.number))
        .catch(() => null);
      if (earlier) return earlier;
    }
    if (outcome.kind === 'rejected') {
      const contested = /nonce|replacement|underpriced/i.test(outcome.reason);
      const hint = contested ? '; an earlier transaction on this lane may still settle, so call pay again with the same run id before treating the run as unpaid' : '';
      return refused(`the node rejected the transaction: ${outcome.reason}${hint}`);
    }
    if (outcome.kind === 'expired') {
      const cause = outcome.unreachable ? ` (broadcast failed: ${outcome.unreachable})` : '';
      return refused(`the transaction was not included before it expired at ${iso(validBefore)}${cause}; it paid nothing and can never be included`, tx.hash);
    }
    if (outcome.kind === 'unknown') {
      const cause = outcome.detail ?? outcome.unreachable ?? 'no receipt yet';
      return refused(`the outcome is unknown (${cause}); call pay again with the same run id, it looks the run up on chain before sending anything`, tx.hash);
    }

    const { receipt } = outcome;
    if (receipt.status === 'reverted') {
      // The receipt has settled that nothing was paid; the trace only adds the name of the reason.
      const reason = decodeRevertReason(await io.revertData(tx.hash).catch(() => null));
      const why = reason ? `${reason.name}: ${reason.message}` : 'the RPC did not return a revert reason';
      return refused(`the transaction reverted on chain and nothing was paid (${why})`, tx.hash, receipt.gasUsed);
    }
    const check = verifyPayoutLogs({ root, token, lines, logs: receipt.logs });
    if (!check.ok) return refused(`the transaction succeeded but its events do not match the run: ${check.problems.join('; ')}`, tx.hash, receipt.gasUsed);
    if (input.keyAuthorization && !keyAuthorizedIn(receipt.logs, root, accessKey)) {
      return refused('the transaction succeeded but its receipt does not show the keychain provisioning the key', tx.hash, receipt.gasUsed);
    }
    return { ok: true, tx: tx.hash, error: null, alreadyPaid: false, gasUsed: receipt.gasUsed };
  }

  async function payOnce(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<TempoPayoutResult> {
    const invalid = requestProblems(i.account, i.lines, i.runId);
    if (invalid.length > 0) return refused(invalid.join('; '));
    const root = getAddress(i.account);
    await io.assertChain();
    // The nonce and the search belong to one block. A payment of this run in a block up to it is in the
    // search, which covers every block up to it or fails. One in a later block, or still pending, holds
    // this very nonce, so the transaction built below can only collide with it, never pay a second time.
    const head = await io.head();
    const nonce = await io.laneNonce(root, head.number);
    const existing = await alreadyOnChain(root, i.lines, i.runId, head.number);
    if (existing) return existing;
    // Read after the search, which is the slow step: key, balances and fees are as fresh as the send.
    const check = await preflight(i);
    if (!check.ok) return refused(check.problems.join('; '));
    return send({ root, lines: i.lines, runId: i.runId, nonce });
  }

  /** Chain-level failures come back as `ok: false`; this never rejects. */
  function pay(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<TempoPayoutResult> {
    return exclusive(() => payOnce(i).catch((error: unknown) => refused(explainError(error))));
  }

  async function authorizeOnce(i: SubmitAuthorizationInput): Promise<TempoPayoutResult> {
    if (!isAddress(i.account)) return refused(`account "${i.account}" is not a valid address`);
    const root = getAddress(i.account);
    // Settled before any network call: the wire grants exactly what the caller expects, to this key, signed by this account's root.
    const checked = verifySignedAuthorization({ wire: i.signedWire, expected: i.expected, account: root, accessKey, token, chainId: settings.chainId });
    if (!checked.ok) return refused(checked.problems.join('; '));
    const { authorization } = checked;
    const run = i.firstRun;
    const invalid = [...accountProblems(root), ...(run ? lineProblems(run.lines, run.runId) : [])];
    if (invalid.length > 0) return refused(invalid.join('; '));

    await io.assertChain();
    const head = await io.head();
    const nonce = await io.laneNonce(root, head.number);
    const existing = run ? await alreadyOnChain(root, run.lines, run.runId, head.number) : null;

    // The key is read after the search, so what is decided next rests on its state now.
    const { key } = await status(root);
    if (key.revoked) return refused(`access key ${accessKey} was revoked on this account, and a revoked key can never be authorized again`);
    if (key.live) {
      const differences = [...key.mismatch, ...differencesFromAuthorization(key, authorization, token)];
      if (differences.length > 0) {
        return refused(`access key ${accessKey} is already authorized on this account, but not on the expected terms: ${differences.join('; ')}; revoke it and authorize a new key`);
      }
      return run ? payOnce({ account: root, lines: run.lines, runId: run.runId }) : { ok: true, tx: null, error: null, alreadyPaid: false, gasUsed: null };
    }
    if (run && existing) return refused(`run ${run.runId} is already on chain in ${existing.tx}; submit the authorization without a first run`, existing.tx);

    const granted = (now: number) => grantedStatus(authorization, token, now);
    const { recipients } = granted(head.timestamp).scope;
    const lines = run ? run.lines : [carrier(recipients?.[0] ?? root)];
    const gas = gasCeiling(lines.length, { recipients: recipients?.length ?? 0 });
    const problems = payoutProblems({ lines, sponsor, facts: await facts(root, gas, granted) });
    if (problems.length > 0) return refused(problems.join('; '));
    return send({ root, lines, runId: run?.runId ?? null, nonce, keyAuthorization: authorization.signed });
  }

  function submitAuthorization(i: SubmitAuthorizationInput): Promise<TempoPayoutResult> {
    return exclusive(() => authorizeOnce(i).catch((error: unknown) => refused(explainError(error))));
  }

  /** Broadcast a call the keychain must refuse, without simulating it first, and report what the chain recorded. */
  async function probe(account: string, to: string, build: (to: Address, key: KeyStatus) => Call | string): Promise<ProbeResult> {
    if (!isAddress(account)) return noReceipt(`account "${account}" is not a valid address`);
    if (!isAddress(to)) return noReceipt(`"${to}" is not a valid address`);
    const root = getAddress(account);
    await io.assertChain();
    const { key, head } = await status(root);
    // Only a bounded key is probed: with a broader one the call might simply go through.
    const unusable = keyProblems(key, head.timestamp)[0];
    if (unusable) return noReceipt(unusable);
    const call = build(getAddress(to), key);
    if (typeof call === 'string') return noReceipt(call);

    const nonce = await io.laneNonce(root);
    const validBefore = head.timestamp + TX_VALIDITY_SECONDS;
    const maxFeePerGas = head.baseFeePerGas > 0n ? head.baseFeePerGas * 2n : 1n;
    const tx = await io.signForced({ root, calls: [call], nonce, validBefore, gas: PROBE_GAS, maxFeePerGas });
    const outcome = await launch(root, tx, nonce, validBefore);
    if (outcome.kind === 'rejected') return noReceipt(`the node rejected the probe before inclusion: ${outcome.reason}`);
    if (outcome.kind === 'expired') return noReceipt('the probe was not included before it expired', tx.hash);
    if (outcome.kind === 'unknown') return noReceipt(`the outcome is unknown (${outcome.detail ?? outcome.unreachable ?? 'no receipt yet'})`, tx.hash);

    // Only the receipt decides whether the transaction failed; the trace merely names the reason.
    const reverted = outcome.receipt.status === 'reverted';
    const returnData = reverted ? await io.revertData(tx.hash).catch(() => null) : null;
    return { tx: tx.hash, includedOnChain: true, reverted, reason: decodeRevertReason(returnData)?.name ?? null, returnData, gasUsed: outcome.receipt.gasUsed, error: null };
  }

  function probing(run: () => Promise<ProbeResult>): Promise<ProbeResult> {
    return exclusive(() => run().catch((error: unknown) => noReceipt(explainError(error))));
  }

  function probeOverLimit(i: { account: string; to: string }): Promise<ProbeResult> {
    return probing(() =>
      probe(i.account, i.to, (to, key) => {
        if (!allowsRecipient(key.scope, to)) return `${to} is outside the key's scope, so the scope check would fire before the limit; probe with an allowed payee`;
        // The largest amount there is, which no limit and no balance can cover. One unit above what is left
        // would prove the same today, but that figure is read before the transaction lands: a window that
        // refills, or a limit the root raises in between, would turn the probe into a payment.
        return transferWithMemoCall(token, to, maxUint256, OVER_LIMIT_MEMO);
      }),
    );
  }

  function probeOutOfScope(i: { account: string; to: string }): Promise<ProbeResult> {
    // One base unit: should the scope change between the read and the block, that is all that can move.
    return probing(() => probe(i.account, i.to, (to) => transferCall(token, to, 1n)));
  }

  return {
    chain: 'tempo',
    accessKeyAddress: accessKey,
    sponsorAddress: sponsor,
    remaining,
    pay,
    keyStatus,
    preflight,
    findRun,
    probeOverLimit,
    probeOutOfScope,
    submitAuthorization,
  };
}

/** Submit a root-signed authorization for the access key in `config`, optionally together with the first payout. Never rejects. */
export async function submitAuthorization(config: TempoRailConfig, input: SubmitAuthorizationInput): Promise<TempoPayoutResult> {
  try {
    return await createTempoPayoutRail(config).submitAuthorization(input);
  } catch (error) {
    return refused(explainError(error));
  }
}
