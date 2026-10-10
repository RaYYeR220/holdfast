import type { PayoutRail } from '@holdfast/core';
import { type Address, type Hex, decodeFunctionData, getAddress, maxUint256, toHex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Abis, Account, Addresses } from 'viem/tempo';
import { describe, expect, it } from 'vitest';
import {
  type AccessKeyPolicyInput,
  DEFAULT_NONCE_KEY,
  type RawKeyState,
  TOKENS,
  TRANSFER_SELECTOR,
  TRANSFER_WITH_MEMO_SELECTOR,
  TX_VALIDITY_SECONDS,
  type TempoChain,
  TempoRailError,
  createTempoPayoutRail,
  memoBytes,
  submitAuthorization,
} from '../src/index';
import { OUTSIDER, PAYEES, ROOT, START, TOKEN, line, policyFor, setup, signAuthorization } from './fake-chain';

const RUN = 'HF-2026-10-0001';
const lines = [line(RUN, 1, PAYEES[0], 1_000_000n), line(RUN, 2, PAYEES[1], 2_500_000n), line(RUN, 3, PAYEES[2], 750_000n)];
const run = { account: ROOT, lines, runId: RUN };

describe('configuration', () => {
  const valid = { network: 'moderato' as const, token: TOKEN, accessKeyPrivateKey: generatePrivateKey(), sponsorPrivateKey: generatePrivateKey() };

  it('is a tempo payout rail', () => {
    const rail: PayoutRail = setup().rail;
    expect(rail.chain).toBe('tempo');
  });

  it('exposes the key id to authorize and the sponsor to fund', () => {
    const { rail, accessKey } = setup();
    expect(rail.accessKeyAddress).toBe(accessKey.address);
    expect(rail.sponsorAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('keeps payouts off the account\'s ordinary nonce lane', () => {
    expect(toHex(DEFAULT_NONCE_KEY)).toBe(toHex('HOLDFAST'));
    expect(() => createTempoPayoutRail({ ...valid, nonceKey: 0n })).toThrow(TempoRailError);
    expect(() => createTempoPayoutRail({ ...valid, nonceKey: 2n ** 256n - 1n })).toThrow(TempoRailError);
  });

  it('rejects malformed keys and addresses up front', () => {
    expect(() => createTempoPayoutRail({ ...valid, accessKeyPrivateKey: '0x1234' })).toThrow(/accessKeyPrivateKey/);
    expect(() => createTempoPayoutRail({ ...valid, sponsorPrivateKey: 'nope' as Hex })).toThrow(/sponsorPrivateKey/);
    expect(() => createTempoPayoutRail({ ...valid, token: '0x20c0' as Hex })).toThrow(/token/);
    expect(() => createTempoPayoutRail({ ...valid, feeToken: '0x20c0' as Hex })).toThrow(/feeToken/);
    expect(() => createTempoPayoutRail({ ...valid, network: 'devnet' as never })).toThrow(/unknown network/);
  });
});

describe('remaining and key status', () => {
  it('reports what is left and when the window refills', async () => {
    const { rail } = setup();
    expect(await rail.remaining(ROOT)).toEqual({ remaining: 10_000_000n, limit: null, resetsAt: (START + 3_600) * 1000 });
  });

  it('reports zero for a revoked, an expired and an unknown key', async () => {
    const revoked = setup();
    revoked.chain.revoke();
    expect(await revoked.rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });
    expect(await revoked.rail.keyStatus(ROOT)).toMatchObject({ authorized: false, live: false, revoked: true });

    const expired = setup();
    expired.chain.key = { ...expired.chain.key, expiry: BigInt(START - 1) };
    expect(await expired.rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });

    const unknown = setup();
    unknown.chain.forget();
    expect(await unknown.rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });
  });

  it('reports a one-off limit without a reset time', async () => {
    const { rail, chain } = setup();
    chain.key = { ...chain.key, periodEnd: 0n };
    expect(await rail.remaining(ROOT)).toEqual({ remaining: 10_000_000n, limit: null, resetsAt: null });
  });

  it('describes the key for the safety page', async () => {
    const { rail, accessKey } = setup();
    expect(await rail.keyStatus(ROOT)).toEqual({
      accessKey: accessKey.address,
      authorized: true,
      live: true,
      mismatch: [],
      revoked: false,
      expiresAt: (START + 86_400) * 1000,
      limited: true,
      remaining: 10_000_000n,
      periodEnd: (START + 3_600) * 1000,
      scope: { unrestricted: false, selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: PAYEES, otherTargets: [] },
    });
  });

  it('reads the key for the account it is asked about, not for the one it was set up with', async () => {
    const { rail } = setup();
    // The key is live on ROOT only; on any other account the keychain has never seen it.
    expect(await rail.keyStatus(OUTSIDER)).toMatchObject({ authorized: false, live: false, revoked: false, remaining: 0n });
    expect(await rail.remaining(OUTSIDER)).toEqual({ remaining: 0n, limit: null, resetsAt: null });
  });

  it('throws on a malformed account or the wrong chain, since there is nothing to report', async () => {
    const { rail, chain } = setup();
    await expect(rail.remaining('nope')).rejects.toThrow(TempoRailError);
    chain.wrongChain = true;
    await expect(rail.keyStatus(ROOT)).rejects.toThrow(/chain 4217/);
  });
});

describe('a key that is broader on chain than the rail accepts', () => {
  const memoRule = { selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES };
  const beta = getAddress(TOKENS.moderato.BetaUSD);
  const broader: [string, Partial<RawKeyState>, string][] = [
    ['no spending limit', { enforceLimits: false, remaining: 0n }, 'it has no spending limit'],
    ['no call scope', { isScoped: false, scopes: [] }, 'it has no call scope and may call anything'],
    ['the whole token', { scopes: [{ target: TOKEN, selectorRules: [] }] }, 'it may call every function of the payout token'],
    ['a second function', { scopes: [{ target: TOKEN, selectorRules: [memoRule, { selector: TRANSFER_SELECTOR, recipients: [] }] }] }, `it may call other functions of the payout token (${TRANSFER_SELECTOR})`],
    ['a second contract', { scopes: [{ target: TOKEN, selectorRules: [memoRule] }, { target: beta, selectorRules: [memoRule] }] }, `it may call other contracts (${beta})`],
    ['another token only', { scopes: [{ target: beta, selectorRules: [memoRule] }] }, 'it may not call transferWithMemo on the payout token'],
  ];

  for (const [label, change, mismatch] of broader) {
    it(`is not authorized and is not paid with: ${label}`, async () => {
      const { rail, chain } = setup();
      chain.key = { ...chain.key, ...change };
      const status = await rail.keyStatus(ROOT);
      expect(status).toMatchObject({ authorized: false, live: true, revoked: false, remaining: 0n, periodEnd: null });
      expect(status.mismatch).toContain(mismatch);
      expect(await rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });

      const preflight = await rail.preflight({ account: ROOT, lines });
      expect(preflight.ok).toBe(false);
      expect(preflight.ok ? [] : preflight.problems).toEqual([expect.stringContaining(`is not the bounded payout key this rail accepts: `)]);
      expect(preflight.ok ? '' : preflight.problems[0]).toContain(mismatch);

      const paid = await rail.pay(run);
      expect(paid).toMatchObject({ ok: false, tx: null });
      expect(paid.error).toContain(mismatch);
      // The probes would not be probes with such a key: the call might simply go through.
      expect((await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).error).toContain(mismatch);
      expect((await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER })).error).toContain(mismatch);
      expect(chain.signed).toHaveLength(0);
      expect(chain.broadcasts).toHaveLength(0);
    });
  }

  it('reads a key limited on some other token as a budget of zero', async () => {
    const { rail, chain } = setup();
    // The keychain answers zero for a token the key has no limit on, exactly as for a spent limit.
    chain.key = { ...chain.key, remaining: 0n, periodEnd: 0n };
    expect(await rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });
    const paid = await rail.pay(run);
    expect(paid).toMatchObject({ ok: false, tx: null });
    expect(paid.error).toContain('the key may only spend 0.00 more');
    expect(chain.signed).toHaveLength(0);
  });

  it('does not pay from an account the key is not authorized on', async () => {
    const { rail, chain } = setup();
    const paid = await rail.pay({ ...run, account: OUTSIDER });
    expect(paid).toMatchObject({ ok: false, tx: null });
    expect(paid.error).toContain('is not authorized on this account');
    expect(chain.signed).toHaveLength(0);
  });
});

describe('pay', () => {
  it('sends one transaction with one memo transfer per line, on the lane, valid for a minute', async () => {
    const { rail, chain } = setup();
    const result = await rail.pay(run);
    expect(result).toEqual({ ok: true, tx: chain.broadcasts[0], error: null, alreadyPaid: false, gasUsed: 110_000n });
    expect(chain.signed).toHaveLength(1);
    const tx = chain.signed[0]!;
    expect(tx.root).toBe(ROOT);
    expect(tx.nonce).toBe(0);
    expect(tx.validBefore - START).toBeGreaterThan(TX_VALIDITY_SECONDS - 1);
    expect(tx.validBefore - START).toBeLessThan(TX_VALIDITY_SECONDS + 30);
    expect(tx.calls.map((call) => call.to)).toEqual([TOKEN, TOKEN, TOKEN].map((token) => expect.stringMatching(new RegExp(token, 'i'))));
    expect(tx.calls.map((call) => decodeFunctionData({ abi: Abis.tip20, data: call.data }).args)).toEqual(lines.map((entry) => [entry.to, entry.amount, memoBytes(entry.memo)]));
    expect((await rail.remaining(ROOT)).remaining).toBe(5_750_000n);
  });

  it('does not pay a run twice', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    const second = await rail.pay(run);
    expect(second).toEqual({ ok: true, tx: first.tx, error: null, alreadyPaid: true, gasUsed: null });
    expect(chain.signed).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
    expect((await rail.remaining(ROOT)).remaining).toBe(5_750_000n);
  });

  it('finds an earlier payment of the run even when the budget is gone by now', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    chain.key = { ...chain.key, remaining: 0n };
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: first.tx, alreadyPaid: true });
  });

  it('refuses to reuse a run id for different lines', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    const changed = await rail.pay({ ...run, lines: [lines[0]!, { ...lines[1]!, amount: 1n }] });
    expect(changed).toMatchObject({ ok: false, tx: first.tx, alreadyPaid: false });
    expect(changed.error).toContain('already on chain');
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('does not send when preflight finds a problem', async () => {
    const { rail, chain } = setup();
    chain.key = { ...chain.key, remaining: 4_000_000n };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('the run totals 4.25 but the key may only spend 4.00 more');
    expect(chain.signed).toHaveLength(0);
  });

  it('requires every memo to carry the run id', async () => {
    const { rail, chain } = setup();
    const result = await rail.pay({ ...run, runId: 'HF-2026-10-0002' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`memo "${RUN}/1" is not "HF-2026-10-0002/<line>"`);
    expect(chain.signed).toHaveLength(0);
  });

  it('finds a run id that was paid with other line numbers', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay({ ...run, lines: [lines[0]!] });
    expect(first.ok).toBe(true);
    // No memo in common with the first payment, same run id.
    const other = await rail.pay({ ...run, lines: [lines[1]!, lines[2]!] });
    expect(other).toMatchObject({ ok: false, tx: first.tx, alreadyPaid: false });
    expect(other.error).toContain('already on chain');
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('refuses to call a run paid when it is on chain twice', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    // A second writer pays the same run behind the rail's back.
    const again = await chain.signForced({ root: ROOT, calls: chain.signed[0]!.calls, nonce: 1, validBefore: chain.time + 60, gas: 1n, maxFeePerGas: 1n });
    await chain.broadcast(again.serialized);
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: first.tx, alreadyPaid: false });
    expect(result.error).toContain(`is on chain in more than one transaction (${first.tx}, ${again.hash})`);
    expect(chain.broadcasts).toHaveLength(2);
  });

  it('does not send when it cannot check whether the run was already paid', async () => {
    const { rail, chain } = setup();
    chain.failing.add('memoLogs');
    expect(await rail.pay(run)).toEqual({ ok: false, tx: null, error: 'memoLogs failed: fetch failed', alreadyPaid: false, gasUsed: null });
    expect(chain.signed).toHaveLength(0);
  });

  it('reports a simulation the node refuses, without a transaction', async () => {
    const { rail, chain } = setup();
    // The limit shrinks between preflight and signing.
    const signPayout = chain.signPayout.bind(chain);
    chain.signPayout = async (tx) => {
      chain.key = { ...chain.key, remaining: 1n };
      return signPayout(tx);
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toBe('the node refused the transaction before it was sent: SpendingLimitExceeded: the transfer exceeds what the access key may still spend');
    expect(chain.broadcasts).toHaveLength(0);
  });

  it('turns a reverted receipt into a failure that names the reason', async () => {
    const { rail, chain } = setup();
    // The limit shrinks after the simulation passed, so the transaction is included and fails.
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      chain.key = { ...chain.key, remaining: 1n };
      return broadcast(serialized);
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0], alreadyPaid: false });
    expect(result.error).toBe('the transaction reverted on chain and nothing was paid (SpendingLimitExceeded: the transfer exceeds what the access key may still spend)');
    expect(chain.rootBalance).toBe(1_000_000_000n);
  });

  it('still reports the revert when the RPC serves no traces', async () => {
    const { rail, chain } = setup();
    chain.servesTraces = false;
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      chain.key = { ...chain.key, remaining: 1n };
      return broadcast(serialized);
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toContain('the RPC did not return a revert reason');
  });

  it('retries a run after a reverted attempt, since nothing was paid', async () => {
    const { rail, chain } = setup();
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      chain.key = { ...chain.key, remaining: 1n };
      return broadcast(serialized);
    };
    expect((await rail.pay(run)).ok).toBe(false);
    chain.broadcast = broadcast;
    chain.key = { ...chain.key, remaining: 10_000_000n };
    const retry = await rail.pay(run);
    expect(retry).toMatchObject({ ok: true, alreadyPaid: false });
    expect(chain.signed.map((tx) => tx.nonce)).toEqual([0, 1]);
  });

  it('does not call a success a success when the events do not match the lines', async () => {
    const { rail, chain } = setup();
    chain.tamper = (logs) => logs.slice(0, -1);
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toContain(`the transaction succeeded but its events do not match the run: line 3 (${RUN}/3): no TransferWithMemo event carries this memo`);
  });

  it('reports a transaction that was never included as expired, with its hash', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'drop';
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0], alreadyPaid: false });
    expect(result.error).toMatch(/^the transaction was not included before it expired at 2026-10-10T.*; it paid nothing and can never be included$/);
    expect(chain.time).toBeGreaterThanOrEqual(chain.signed[0]!.validBefore);
  });

  it('can be called again after an expired attempt, and pays once', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'drop';
    expect((await rail.pay(run)).ok).toBe(false);
    chain.onBroadcast = 'mine';
    const retry = await rail.pay(run);
    expect(retry).toMatchObject({ ok: true, alreadyPaid: false });
    // Same lane nonce as the dead attempt: only one of the two could ever have been included.
    expect(chain.signed.map((tx) => tx.nonce)).toEqual([0, 0]);
    expect((await rail.remaining(ROOT)).remaining).toBe(5_750_000n);
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: retry.tx, alreadyPaid: true });
  });

  it('finds the payment when the broadcast went through but its response was lost', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'lost';
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0], alreadyPaid: false });
  });

  it('reports an unreachable node as expired once the validity window has closed', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'unreachable';
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toContain('(broadcast failed: fetch failed)');
    expect(result.error).toContain('it paid nothing');
  });

  it('says the outcome is unknown when the node stops answering after the broadcast', async () => {
    const { rail, chain } = setup();
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      const sent = await broadcast(serialized);
      chain.failing.add('receipt');
      return sent;
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toMatch(/^the outcome is unknown \(receipt failed: fetch failed\); call pay again with the same run id/);
    // The payment did land; the next call finds it instead of sending again.
    chain.failing.clear();
    chain.broadcast = broadcast;
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: result.tx, alreadyPaid: true });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('does not call a transaction expired while its nonce has been used', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'drop';
    const head = chain.head.bind(chain);
    chain.head = async () => {
      // Something consumes the nonce while the node shows no receipt for this hash.
      if (chain.signed.length === 1 && chain.nonce === 0) chain.useNonce();
      return head();
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toContain('the outcome is unknown (the nonce was used but the node has no receipt for the transaction)');
  });

  it('returns the earlier payment when the node says the nonce is already used', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    expect(first.ok).toBe(true);
    // A lagging node: it has neither the payment's logs nor the lane's new nonce yet.
    const memoLogs = chain.memoLogs.bind(chain);
    let lookups = 0;
    chain.memoLogs = async (query) => (lookups++ === 0 ? [] : memoLogs(query));
    chain.laneNonce = async () => 0;
    const again = await rail.pay(run);
    expect(again).toMatchObject({ ok: true, tx: first.tx, alreadyPaid: true });
    expect(chain.broadcasts).toHaveLength(2);
    expect(chain.receipts.size).toBe(1);
    expect(chain.rootBalance).toBe(1_000_000_000n - 4_250_000n);
  });

  it('reports a rejection by the node', async () => {
    const { rail, chain } = setup();
    chain.broadcast = async () => ({ accepted: false, reason: 'insufficient funds for gas * price + value: have 0 want 486' });
    expect(await rail.pay(run)).toEqual({
      ok: false,
      tx: null,
      error: 'the node rejected the transaction: insufficient funds for gas * price + value: have 0 want 486',
      alreadyPaid: false,
      gasUsed: null,
    });
  });

  it('does not call a run unpaid when the node refuses to replace an earlier attempt', async () => {
    const { rail, chain } = setup();
    chain.broadcast = async () => ({ accepted: false, reason: 'replacement transaction underpriced' });
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('an earlier transaction on this lane may still settle');
  });

  it('resolves to the earlier payment when its own transaction never makes it', async () => {
    const { rail, chain } = setup();
    const paid = await rail.pay(run);
    expect(paid.ok).toBe(true);
    // A lagging node hides the payment from the next call, and the pool swallows the new transaction.
    const memoLogs = chain.memoLogs.bind(chain);
    let lookups = 0;
    chain.memoLogs = async (query) => (lookups++ === 0 ? [] : memoLogs(query));
    chain.laneNonce = async () => 0;
    chain.broadcast = async () => ({ accepted: true });
    const again = await rail.pay(run);
    expect(again).toMatchObject({ ok: true, tx: paid.tx, alreadyPaid: true });
    expect(chain.receipts.size).toBe(1);
  });

  it('reads the nonce and ends the search for an earlier payment at one and the same block', async () => {
    const { rail, chain } = setup();
    expect((await rail.pay(run)).ok).toBe(true);
    const pinned = chain.nonceReads[0];
    expect(pinned).not.toBeNull();
    expect(chain.searches).toHaveLength(1);
    expect(chain.searches[0]?.toBlock).toBe(pinned);
    expect(chain.searches[0]?.fromBlock).toBe((pinned ?? 0n) - 1_000_000n);
  });

  it('does not send when the nonce cannot be read as of the block the search ends at', async () => {
    const { rail, chain } = setup();
    // A node that is behind refuses a read pinned to a block it does not have.
    chain.laneNonce = async (_root, atBlock) => {
      if (atBlock !== undefined) throw Object.assign(new Error(`block not found: 0x${atBlock.toString(16)}`), { code: -32001 });
      return 0;
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('block not found');
    expect(chain.signed).toHaveLength(0);
  });

  it('does not send when the payment it found cannot be read back', async () => {
    const { rail, chain } = setup();
    expect((await rail.pay(run)).ok).toBe(true);
    chain.failing.add('receipt');
    expect(await rail.pay(run)).toEqual({ ok: false, tx: null, error: 'receipt failed: fetch failed', alreadyPaid: false, gasUsed: null });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('still recognises the payment when the node serves its logs but not its receipt', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    chain.receipt = async () => null;
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: first.tx, alreadyPaid: true });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('calls a transaction expired only on a nonce read pinned to a block past its deadline', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'drop';
    const result = await rail.pay(run);
    expect(result.error).toContain('it paid nothing and can never be included');
    const deadline = chain.signed[0]!.validBefore;
    // The read that settled it names a block, and that block's time is at or past the deadline.
    const settledAt = chain.nonceReads.filter((block): block is bigint => block !== null).at(-1) ?? 0n;
    expect(settledAt).toBeGreaterThan(chain.searches[0]?.toBlock ?? 0n);
    expect(chain.time).toBeGreaterThanOrEqual(deadline);
    expect(chain.nonceReads.slice(1).every((block) => block !== null)).toBe(true);
  });

  it('says unknown, not expired, when the nonce cannot be read as of the block that closed the window', async () => {
    const { rail, chain } = setup();
    chain.onBroadcast = 'drop';
    const laneNonce = chain.laneNonce.bind(chain);
    let reads = 0;
    // The first read, before sending, is answered; every later one hits a node that lacks the block.
    chain.laneNonce = async (root, atBlock) => {
      if (reads++ === 0) return laneNonce(root, atBlock);
      throw Object.assign(new Error('block not found'), { code: -32001 });
    };
    const result = await rail.pay(run);
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toMatch(/^the outcome is unknown \(block not found\)/);
    expect(result.error).not.toContain('paid nothing');
  });

  it('never throws, whatever fails underneath', async () => {
    const methods = ['assertChain', 'head', 'keyState', 'balanceOf', 'laneNonce', 'memoLogs', 'receipt', 'signPayout', 'broadcast', 'revertData'] as const;
    for (const method of methods) {
      const { rail, chain } = setup();
      chain.failing.add(method);
      const result = await rail.pay(run);
      expect(typeof result.ok, method).toBe('boolean');
      if (!result.ok) expect(result.error, method).toEqual(expect.any(String));
    }
    const { rail, chain } = setup();
    chain.wrongChain = true;
    expect(await rail.pay(run)).toMatchObject({ ok: false, tx: null, error: 'the RPC serves chain 4217, but moderato is chain 42431' });
    expect(await rail.pay({ account: 'nope', lines, runId: RUN })).toMatchObject({ ok: false, tx: null });
  });

  it('sends concurrent runs one after another, each on its own nonce', async () => {
    const { rail, chain } = setup();
    const second = 'HF-2026-10-0002';
    const results = await Promise.all([rail.pay(run), rail.pay({ account: ROOT, runId: second, lines: [line(second, 1, PAYEES[0], 1n)] })]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(chain.signed.map((tx) => tx.nonce)).toEqual([0, 1]);
  });
});

describe('findRun', () => {
  it('locates a run from its memos alone', async () => {
    const { rail } = setup();
    const paid = await rail.pay(run);
    const found = await rail.findRun(ROOT, RUN);
    expect(found?.tx).toBe(paid.tx);
    expect(found?.otherTxs).toEqual([]);
    expect(found?.lines.map(({ to, amount, memo }) => ({ to, amount, memo }))).toEqual(lines);
    expect(found?.lines.every((entry) => Number.isInteger(entry.logIndex))).toBe(true);
  });

  it('returns null for a run that is not on chain', async () => {
    const { rail } = setup();
    await rail.pay(run);
    expect(await rail.findRun(ROOT, 'HF-2026-10-0009')).toBeNull();
    expect(await rail.findRun(OUTSIDER, RUN)).toBeNull();
  });

  it('finds a run whatever line numbers it used', async () => {
    const { rail } = setup();
    const sparse = [
      { to: PAYEES[0], amount: 1n, memo: 'HF-7/32' },
      { to: PAYEES[1], amount: 2n, memo: 'HF-7/17' },
    ];
    const paid = await rail.pay({ account: ROOT, runId: 'HF-7', lines: sparse });
    expect(paid.ok).toBe(true);
    expect((await rail.findRun(ROOT, 'HF-7'))?.lines.map((entry) => entry.memo)).toEqual(['HF-7/32', 'HF-7/17']);
    // A run id that merely starts the same way is a different run.
    expect(await rail.findRun(ROOT, 'HF-70')).toBeNull();
  });

  it('only looks as far back as it is told to', async () => {
    const { rail, chain } = setup();
    await rail.pay(run);
    chain.block += 500n;
    expect(await rail.findRun(ROOT, RUN, { lookbackBlocks: 100n })).toBeNull();
    expect(await rail.findRun(ROOT, RUN, { lookbackBlocks: 1_000n })).not.toBeNull();
  });

  it('lists every transaction that carries the run when it was paid more than once', async () => {
    const { rail, chain } = setup();
    const first = await rail.pay(run);
    // A second writer pays the same run behind the rail's back.
    const again = await chain.signForced({ root: ROOT, calls: chain.signed[0]!.calls, nonce: 1, validBefore: chain.time + 60, gas: 1n, maxFeePerGas: 1n });
    await chain.broadcast(again.serialized);
    expect(await rail.findRun(ROOT, RUN)).toMatchObject({ tx: first.tx, otherTxs: [again.hash] });
  });

  it('rejects a malformed run id or account', async () => {
    const { rail } = setup();
    await expect(rail.findRun(ROOT, 'HF/1')).rejects.toThrow(TempoRailError);
    await expect(rail.findRun('nope', RUN)).rejects.toThrow(TempoRailError);
  });

  it('rejects instead of answering "not found" when the search could not be completed', async () => {
    const { rail, chain } = setup();
    await rail.pay(run);
    chain.failing.add('memoLogs');
    await expect(rail.findRun(ROOT, RUN)).rejects.toThrow('memoLogs failed');
  });
});

describe('safety probes', () => {
  it('lands a transfer no limit can cover and reads back the keychain\'s refusal', async () => {
    const { rail, chain } = setup();
    const result = await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] });
    expect(result).toEqual({ tx: chain.broadcasts[0], includedOnChain: true, reverted: true, reason: 'SpendingLimitExceeded', returnData: '0x8a9e71ea', gasUsed: 70_000n, error: null });
    expect(chain.rootBalance).toBe(1_000_000_000n);
    expect((await rail.remaining(ROOT)).remaining).toBe(10_000_000n);
  });

  it('probes with an amount that cannot be paid even if the budget grows before the probe lands', async () => {
    const { rail, chain } = setup();
    chain.key = { ...chain.key, remaining: 3_930_000n };
    // Between the read and the block, the window refills and the root raises the limit.
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      chain.key = { ...chain.key, remaining: 1_000_000_000n };
      return broadcast(serialized);
    };
    const result = await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] });
    expect(decodeFunctionData({ abi: Abis.tip20, data: chain.signed[0]!.calls[0]!.data }).args).toEqual([PAYEES[0], maxUint256, memoBytes('HF-PROBE-OVER-LIMIT')]);
    expect(result).toMatchObject({ includedOnChain: true, reverted: true, reason: 'SpendingLimitExceeded' });
    expect(chain.rootBalance).toBe(1_000_000_000n);
  });

  it('lands a plain transfer of one unit and reads back the scope refusal', async () => {
    const { rail, chain } = setup();
    const result = await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER });
    expect(result).toEqual({ tx: chain.broadcasts[0], includedOnChain: true, reverted: true, reason: 'CallNotAllowed', returnData: '0x576b38b4', gasUsed: 70_000n, error: null });
    expect(decodeFunctionData({ abi: Abis.tip20, data: chain.signed[0]!.calls[0]!.data })).toMatchObject({ functionName: 'transfer', args: [OUTSIDER, 1n] });
  });

  it('reports the revert without a reason when the RPC serves no traces', async () => {
    const { rail, chain } = setup();
    chain.servesTraces = false;
    expect(await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({ includedOnChain: true, reverted: true, reason: null, returnData: null, error: null });
    chain.servesTraces = true;
    chain.failing.add('revertData');
    expect(await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER })).toMatchObject({ includedOnChain: true, reverted: true, reason: null });
  });

  it('never reports a revert the receipt does not show', async () => {
    const { rail, chain } = setup();
    // The scope is widened after the key was read: the plain transfer of one unit goes through.
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async (serialized) => {
      chain.key = { ...chain.key, isScoped: false, scopes: [] };
      return broadcast(serialized);
    };
    expect(await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER })).toMatchObject({ includedOnChain: true, reverted: false, reason: null, error: null });
    expect(chain.rootBalance).toBe(1_000_000_000n - 1n);

    const dropped = setup();
    dropped.chain.onBroadcast = 'drop';
    expect(await dropped.rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({
      tx: dropped.chain.broadcasts[0],
      includedOnChain: false,
      reverted: false,
      error: 'the probe was not included before it expired',
    });
  });

  it('does not send an over-limit probe to a payee the scope would refuse first', async () => {
    const { rail, chain } = setup();
    expect((await rail.probeOverLimit({ account: ROOT, to: OUTSIDER })).error).toContain("is outside the key's scope");
    expect(chain.signed).toHaveLength(0);
  });

  it('has nothing to probe with a revoked key, and never throws', async () => {
    const { rail, chain } = setup();
    chain.revoke();
    expect(await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({ tx: null, includedOnChain: false, reverted: false, error: expect.stringContaining('was revoked') });
    expect(await rail.probeOutOfScope({ account: 'nope', to: OUTSIDER })).toMatchObject({ tx: null, error: 'account "nope" is not a valid address' });
    expect(await rail.probeOutOfScope({ account: ROOT, to: 'nope' })).toMatchObject({ tx: null, error: '"nope" is not a valid address' });
    const failing = setup();
    failing.chain.failing.add('signForced');
    expect(await failing.rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({ tx: null, includedOnChain: false, error: 'signForced failed: fetch failed' });
  });
});

describe('submitting a root-signed authorization', () => {
  const everyRead: (keyof TempoChain)[] = ['assertChain', 'head', 'keyState', 'balanceOf', 'laneNonce', 'memoLogs', 'receipt', 'signPayout', 'signForced', 'broadcast', 'revertData'];

  /** The terms the caller expects, and a wire the account's root signed for those same terms. */
  async function signedFor(accessKeyAddress: Address, over: Partial<AccessKeyPolicyInput> = {}) {
    const expected = policyFor(accessKeyAddress, over);
    return { expected, signedWire: await signAuthorization(expected) };
  }

  it('provisions the key with a zero transfer to the first listed payee', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address)) });
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0], error: null });
    const tx = chain.signed[0]!;
    expect(tx.keyAuthorization?.address.toLowerCase()).toBe(accessKey.address.toLowerCase());
    expect(tx.calls.map((call) => decodeFunctionData({ abi: Abis.tip20, data: call.data }).args)).toEqual([[PAYEES[0], 0n, memoBytes('HF-KEY-AUTHORIZED')]]);
    expect(await rail.keyStatus(ROOT)).toMatchObject({ authorized: true, remaining: 10_000_000n });
  });

  it('sends the zero transfer to the account itself when the key may pay anyone', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    expect((await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address, { recipients: [] })) })).ok).toBe(true);
    expect(decodeFunctionData({ abi: Abis.tip20, data: chain.signed[0]!.calls[0]!.data }).args).toEqual([ROOT, 0n, memoBytes('HF-KEY-AUTHORIZED')]);
  });

  it('provisions the key and pays the first run in one transaction', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address)), firstRun: { lines, runId: RUN } });
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0] });
    expect(chain.signed).toHaveLength(1);
    expect(chain.signed[0]!.calls).toHaveLength(3);
    expect((await rail.remaining(ROOT)).remaining).toBe(5_750_000n);
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: result.tx, alreadyPaid: true });
  });

  it('checks the first run against the authorization before sending', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const small = await signedFor(accessKey.address, { limit: 4_000_000n });
    const result = await rail.submitAuthorization({ account: ROOT, ...small, firstRun: { lines, runId: RUN } });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('the run totals 4.25 but the key may only spend 4.00 more');
    const narrow = await signedFor(accessKey.address, { recipients: PAYEES.slice(0, 2) });
    expect((await rail.submitAuthorization({ account: ROOT, ...narrow, firstRun: { lines, runId: RUN } })).error).toContain("line 3: 0x166EAfA209a18A105D592c726d21e19D2ad37568 is not on the key's recipient allow-list");
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses an authorization that has already expired on chain time', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address, { expiry: START - 10 })) });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toMatch(/ expired at 2026-10-10T/);
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses a wire that grants anything but the expected terms, without asking the chain', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    // Every chain call would fail: the refusals below are reached on the wire and the expectation alone.
    for (const method of everyRead) chain.failing.add(method);
    const expected = policyFor(accessKey.address);
    const granted: [string, Partial<AccessKeyPolicyInput>, RegExp][] = [
      ['a larger limit', { limit: 20_000_000n }, /it allows 20\.00 per 3600 s, expected 10\.00 per 3600 s/],
      ['a shorter window', { periodSeconds: 60 }, /it allows 10\.00 per 60 s, expected 10\.00 per 3600 s/],
      ['a later expiry', { expiry: START + 2 * 86_400 }, /it expires 2026-10-12T.*, expected 2026-10-11T/],
      ['another payee', { recipients: [PAYEES[0], PAYEES[1], OUTSIDER] }, /it may pay \[.*0x747a4B.*\], expected \[/],
      ['any payee', { recipients: [] }, /it may pay anyone, expected \[/],
      ['another token', { token: TOKENS.moderato.BetaUSD }, /its spending limit is on token 0x20C0000000000000000000000000000000000002/],
      ['another chain', { chainId: 4217 }, /the authorization is for chain 4217, this rail runs on chain 42431/],
      ['another key', { accessKeyAddress: Account.fromP256(generatePrivateKey()).address }, /the authorization is for key 0x/],
    ];
    for (const [label, over, message] of granted) {
      const signedWire = await signAuthorization(policyFor(accessKey.address, over));
      const result = await rail.submitAuthorization({ account: ROOT, signedWire, expected });
      expect(result, label).toMatchObject({ ok: false, tx: null });
      expect(result.error, label).toMatch(message);
    }
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: '0x1234', expected })).error).toContain('the authorization cannot be read');
    expect((await rail.submitAuthorization({ account: 'nope', signedWire: '0x', expected })).error).toContain('is not a valid address');
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses a wire signed by anyone but the root of the account', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const expected = policyFor(accessKey.address);
    const stranger = Account.fromSecp256k1(generatePrivateKey());
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: await signAuthorization(expected, stranger), expected });
    expect(result).toEqual({ ok: false, tx: null, error: `the authorization is not signed by the root key of ${ROOT}`, alreadyPaid: false, gasUsed: null });
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses an expectation that is not about this account, key, token or chain', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const mine = await signedFor(accessKey.address);
    const submit = (over: Partial<AccessKeyPolicyInput>) => rail.submitAuthorization({ account: ROOT, signedWire: mine.signedWire, expected: { ...mine.expected, ...over } });
    expect((await submit({ rootAddress: OUTSIDER })).error).toContain(`the expected policy is for account ${OUTSIDER}, not ${ROOT}`);
    expect((await submit({ token: TOKENS.moderato.BetaUSD })).error).toContain('the expected policy is for token');
    expect((await submit({ chainId: 4217 })).error).toContain('the expected policy is for chain 4217');
    expect((await submit({ accessKeyAddress: OUTSIDER })).error).toContain('the expected policy is for key');
    expect((await submit({ limit: 0n })).error).toContain('the expected policy is not valid: limit must be positive');
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses a key that is already live on other terms than the expected ones', async () => {
    const { rail, chain, accessKey } = setup();
    // On chain: expiry START + 1 day, the three payees, 10.00 left.
    const cases: [Partial<AccessKeyPolicyInput>, string][] = [
      [{ expiry: START + 3_600 }, 'it expires 2026-10-11T'],
      [{ recipients: PAYEES.slice(0, 2) }, 'it may pay ['],
      [{ limit: 5_000_000n }, 'it may still spend 10.00, more than the expected limit of 5.00'],
    ];
    for (const [over, difference] of cases) {
      const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address, over)), firstRun: { lines: [lines[0]!], runId: RUN } });
      expect(result).toMatchObject({ ok: false, tx: null });
      expect(result.error).toContain('is already authorized on this account, but not on the expected terms');
      expect(result.error).toContain(difference);
    }
    chain.key = { ...chain.key, isScoped: false, scopes: [] };
    const unscoped = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address)) });
    expect(unscoped.error).toContain('it has no call scope and may call anything');
    expect(chain.signed).toHaveLength(0);
  });

  it('has nothing to do for a key that is already live on the expected terms, and pays the first run through the normal path', async () => {
    const { rail, chain, accessKey } = setup();
    const signed = await signedFor(accessKey.address);
    expect(await rail.submitAuthorization({ account: ROOT, ...signed })).toEqual({ ok: true, tx: null, error: null, alreadyPaid: false, gasUsed: null });
    expect(chain.signed).toHaveLength(0);
    expect(await rail.submitAuthorization({ account: ROOT, ...signed, firstRun: { lines, runId: RUN } })).toMatchObject({ ok: true, alreadyPaid: false });
    expect(chain.signed[0]!.keyAuthorization).toBeUndefined();
  });

  it('does not report success unless the receipt shows the keychain provisioning the key', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    chain.tamper = (logs) => logs.filter((log) => log.address !== Addresses.accountKeychain);
    const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address)) });
    expect(result).toMatchObject({ ok: false, tx: chain.broadcasts[0] });
    expect(result.error).toBe('the transaction succeeded but its receipt does not show the keychain provisioning the key');
  });

  it('refuses an account that is its own fee sponsor, with or without a first run', async () => {
    const { rail, chain, accessKey, sponsorPrivateKey } = setup();
    chain.forget();
    const expected = policyFor(accessKey.address, { rootAddress: rail.sponsorAddress });
    const signedWire = await signAuthorization(expected, Account.fromSecp256k1(sponsorPrivateKey));
    const refusal = { ok: false, tx: null, error: 'the fee sponsor must be a different account from the one paying out' };
    expect(await rail.submitAuthorization({ account: rail.sponsorAddress, signedWire, expected })).toMatchObject(refusal);
    expect(await rail.submitAuthorization({ account: rail.sponsorAddress, signedWire, expected, firstRun: { lines, runId: RUN } })).toMatchObject(refusal);
    expect(chain.signed).toHaveLength(0);
  });

  it('returns a refusal instead of throwing when called standalone with a bad configuration', async () => {
    const config = { network: 'moderato' as const, token: TOKEN, accessKeyPrivateKey: '0x12' as Hex, sponsorPrivateKey: generatePrivateKey() };
    expect(await submitAuthorization(config, { account: ROOT, signedWire: '0x', expected: policyFor(OUTSIDER) })).toEqual({
      ok: false,
      tx: null,
      error: 'accessKeyPrivateKey must be a 32-byte hex private key',
      alreadyPaid: false,
      gasUsed: null,
    });
  });

  it('refuses to resubmit for a revoked key', async () => {
    const { rail, chain, accessKey } = setup();
    chain.revoke();
    const result = await rail.submitAuthorization({ account: ROOT, ...(await signedFor(accessKey.address)) });
    expect(result.error).toContain('a revoked key can never be authorized again');
    expect(chain.signed).toHaveLength(0);
  });
});
