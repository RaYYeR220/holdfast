import type { PayoutAllowance, PayoutLine } from '@holdfast/core';
import type { KeyAuthorization } from 'ox/tempo';
import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from 'viem';
import { type SignedAuthorization, readSignedAuthorization } from './authorization';
import type { ChainHead, ChainReceipt, SignedTx, TempoChain } from './chain';
import { TempoRailError, resolveConfig } from './config';
import { allowsRecipient, allowsSelector, grantedStatus, toKeyStatus } from './key-status';
import { memoBytes, runIdProblem, runMemos } from './memo';
import { TX_VALIDITY_SECONDS, feeCeiling, gasCeiling, keyProblems, lineProblems, payoutProblems } from './preflight';
import type { PayoutFacts } from './preflight';
import { decodeRevertReason, explainError } from './reasons';
import { runLines, sameLines, verifyPayoutLogs } from './receipt';
import { type Call, TRANSFER_SELECTOR, TRANSFER_WITH_MEMO_SELECTOR, transferCall, transferWithMemoCall } from './tip20';
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
 * The run id reaches the chain through the memos: every line's memo must be
 * `<runId>/<line>` with a line from 1 to 32 (`lineMemo` builds it), and the
 * token emits the memo as an indexed event topic. A run can therefore carry
 * only 32 different memos, `findRun` searches for all of them, and that is
 * what makes `pay` safe to repeat for the same run id.
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

  async function status(root: Address): Promise<{ key: KeyStatus; head: ChainHead }> {
    const [raw, head] = await Promise.all([io.keyState(root), io.head()]);
    return { key: toKeyStatus(raw, accessKey, token, head.timestamp), head };
  }

  async function facts(root: Address, gas: bigint, granted?: KeyStatus): Promise<PayoutFacts> {
    const [current, rootBalance, sponsorBalance] = await Promise.all([status(root), io.balanceOf(token, root), io.balanceOf(settings.feeToken, sponsor)]);
    return {
      now: current.head.timestamp,
      key: granted ?? current.key,
      rootBalance,
      sponsorBalance,
      feeCeiling: feeCeiling(gas, current.head.baseFeePerGas),
    };
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
      const problems = payoutProblems({ lines: i.lines, token, sponsor, facts: await facts(getAddress(i.account), gasCeiling(i.lines.length)) });
      return problems.length === 0 ? { ok: true } : { ok: false, problems };
    } catch (error) {
      return { ok: false, problems: [`could not read the chain: ${explainError(error)}`] };
    }
  }

  async function findRun(account: string, runId: string, options: FindRunOptions = {}): Promise<RunOnChain | null> {
    const root = requireAccount(account);
    const problem = runIdProblem(runId);
    if (problem) throw new TempoRailError(problem);
    await io.assertChain();
    const head = await io.head();
    const lookback = options.lookbackBlocks ?? settings.lookbackBlocks;
    const fromBlock = head.number > lookback ? head.number - lookback : 0n;
    const logs = await io.memoLogs({ root, memos: runMemos(runId).map(memoBytes), fromBlock, toBlock: head.number });
    const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    const first = ordered[0];
    if (!first) return null;
    const hashes = [...new Set(ordered.map((log) => log.transactionHash))];
    const receipt = await io.receipt(first.transactionHash);
    const source = receipt?.logs ?? ordered.filter((log) => log.transactionHash === first.transactionHash);
    return { tx: first.transactionHash, blockNumber: first.blockNumber, lines: runLines(source, root, token, runId), otherTxs: hashes.slice(1) };
  }

  /** What the chain already holds for this run id, whatever lines it was paid with; null when it holds nothing. */
  async function alreadyOnChain(root: Address, lines: readonly PayoutLine[], runId: string): Promise<TempoPayoutResult | null> {
    const found = await findRun(root, runId);
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
   * Chain time decides, not the local clock: once a block is stamped at or
   * after `validBefore`, a transaction that has no receipt and has not used
   * its nonce is dead for good.
   */
  async function settle(root: Address, hash: Hex, nonce: number, validBefore: number): Promise<Outcome> {
    const giveUpAt = clock() + (TX_VALIDITY_SECONDS + SETTLE_GRACE_SECONDS) * 1000;
    let detail: string | null = null;
    for (;;) {
      try {
        const receipt = await io.receipt(hash);
        if (receipt) return { kind: 'included', receipt };
        if ((await io.head()).timestamp >= validBefore) {
          const late = await io.receipt(hash);
          if (late) return { kind: 'included', receipt: late };
          if ((await io.laneNonce(root)) <= nonce) return { kind: 'expired' };
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
      const earlier = await alreadyOnChain(root, lines, runId).catch(() => null);
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
      const reason = decodeRevertReason(await io.revertData(tx.hash).catch(() => null));
      const why = reason ? `${reason.name}: ${reason.message}` : 'the RPC did not return a revert reason';
      return refused(`the transaction reverted on chain and nothing was paid (${why})`, tx.hash, receipt.gasUsed);
    }
    const check = verifyPayoutLogs({ root, token, lines, logs: receipt.logs });
    if (!check.ok) return refused(`the transaction succeeded but its events do not match the run: ${check.problems.join('; ')}`, tx.hash, receipt.gasUsed);
    return { ok: true, tx: tx.hash, error: null, alreadyPaid: false, gasUsed: receipt.gasUsed };
  }

  async function payOnce(i: { account: string; lines: PayoutLine[]; runId: string }): Promise<TempoPayoutResult> {
    const invalid = requestProblems(i.account, i.lines, i.runId);
    if (invalid.length > 0) return refused(invalid.join('; '));
    const root = getAddress(i.account);
    await io.assertChain();
    // The lane is read before the run is looked up: a transaction of this run that lands in between
    // has used this nonce, so the one built below collides with it instead of paying a second time.
    const nonce = await io.laneNonce(root);
    const existing = await alreadyOnChain(root, i.lines, i.runId);
    if (existing) return existing;
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
    let authorization: SignedAuthorization;
    try {
      authorization = readSignedAuthorization(i.signedWire);
    } catch (error) {
      return refused(`the authorization cannot be read: ${explainError(error)}`);
    }
    if (!isAddressEqual(authorization.accessKey, accessKey)) return refused(`the authorization is for key ${authorization.accessKey}, this rail signs with ${accessKey}`);
    if (authorization.chainId !== settings.chainId) return refused(`the authorization is for chain ${authorization.chainId}, this rail runs on chain ${settings.chainId}`);
    const run = i.firstRun;
    const invalid = [...accountProblems(root), ...(run ? lineProblems(run.lines, run.runId) : [])];
    if (invalid.length > 0) return refused(invalid.join('; '));

    await io.assertChain();
    const nonce = await io.laneNonce(root);
    const { key, head } = await status(root);
    if (key.revoked) return refused(`access key ${accessKey} was revoked on this account, and a revoked key can never be authorized again`);
    if (key.authorized) return run ? payOnce({ account: root, lines: run.lines, runId: run.runId }) : { ok: true, tx: null, error: null, alreadyPaid: false, gasUsed: null };
    if (run) {
      const existing = await alreadyOnChain(root, run.lines, run.runId);
      if (existing) return refused(`run ${run.runId} is already on chain in ${existing.tx}; submit the authorization without a first run`, existing.tx);
    }

    const granted = grantedStatus(authorization, token, head.timestamp);
    if (!allowsSelector(granted.scope, TRANSFER_WITH_MEMO_SELECTOR)) return refused(`the authorization does not allow transferWithMemo on ${token}, so this rail could not use the key`);
    const lines = run ? run.lines : [carrier(granted.scope.recipients?.[0] ?? root)];
    const gas = gasCeiling(lines.length, { recipients: granted.scope.recipients?.length ?? 0 });
    const problems = payoutProblems({ lines, token, sponsor, facts: await facts(root, gas, granted) });
    if (problems.length > 0) return refused(problems.join('; '));

    const result = await send({ root, lines, runId: run?.runId ?? null, nonce, keyAuthorization: authorization.signed });
    if (!result.ok) return result;
    // A failed read here must not turn a transaction that succeeded into one that is reported as unsent.
    const after = await status(root).catch(() => null);
    if (after && !after.key.authorized) return refused('the transaction succeeded but the keychain does not list the key as authorized', result.tx, result.gasUsed);
    return result;
  }

  function submitAuthorization(i: SubmitAuthorizationInput): Promise<TempoPayoutResult> {
    return exclusive(() => authorizeOnce(i).catch((error: unknown) => refused(explainError(error))));
  }

  /** Broadcast calls the keychain must refuse, without simulating them first, and report what the chain recorded. */
  async function probe(account: string, to: string, build: (to: Address, key: KeyStatus) => Call | string): Promise<ProbeResult> {
    if (!isAddress(account)) return noReceipt(`account "${account}" is not a valid address`);
    if (!isAddress(to)) return noReceipt(`"${to}" is not a valid address`);
    const root = getAddress(account);
    await io.assertChain();
    const { key, head } = await status(root);
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
        if (!key.limited) return 'the key has no spending limit to exceed';
        if (!allowsRecipient(key.scope, to)) return `${to} is outside the key's scope, so the scope check would fire before the limit; probe with an allowed payee`;
        return transferWithMemoCall(token, to, key.remaining + 1n, OVER_LIMIT_MEMO);
      }),
    );
  }

  function probeOutOfScope(i: { account: string; to: string }): Promise<ProbeResult> {
    return probing(() =>
      probe(i.account, i.to, (to, key) => {
        if (allowsSelector(key.scope, TRANSFER_SELECTOR)) return "the key's scope allows a plain transfer, so this probe would move funds; nothing was sent";
        return transferCall(token, to, 1n);
      }),
    );
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
