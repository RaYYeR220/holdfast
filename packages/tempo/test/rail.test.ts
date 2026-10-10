import type { PayoutRail } from '@holdfast/core';
import { type Hex, decodeFunctionData, toHex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { Abis, Account } from 'viem/tempo';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NONCE_KEY,
  TOKENS,
  TRANSFER_WITH_MEMO_SELECTOR,
  TX_VALIDITY_SECONDS,
  TempoRailError,
  UNLIMITED,
  buildAccessKeyAuthorization,
  createTempoPayoutRail,
  memoBytes,
  serializeSignedAuthorization,
  submitAuthorization,
} from '../src/index';
import { OUTSIDER, PAYEES, ROOT, START, TOKEN, line, setup } from './fake-chain';

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
    expect(await revoked.rail.keyStatus(ROOT)).toMatchObject({ authorized: false, revoked: true });

    const expired = setup();
    expired.chain.key = { ...expired.chain.key, expiry: BigInt(START - 1) };
    expect(await expired.rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });

    const unknown = setup();
    unknown.chain.forget();
    expect(await unknown.rail.remaining(ROOT)).toEqual({ remaining: 0n, limit: null, resetsAt: null });
  });

  it('reports a one-off limit without a reset time, and an unlimited key as unlimited', async () => {
    const { rail, chain } = setup();
    chain.key = { ...chain.key, periodEnd: 0n };
    expect((await rail.remaining(ROOT)).resetsAt).toBeNull();
    chain.key = { ...chain.key, enforceLimits: false, remaining: 0n };
    expect((await rail.remaining(ROOT)).remaining).toBe(UNLIMITED);
  });

  it('describes the key for the safety page', async () => {
    const { rail, accessKey } = setup();
    expect(await rail.keyStatus(ROOT)).toEqual({
      accessKey: accessKey.address,
      authorized: true,
      revoked: false,
      expiresAt: (START + 86_400) * 1000,
      limited: true,
      remaining: 10_000_000n,
      periodEnd: (START + 3_600) * 1000,
      scope: { unrestricted: false, selectors: [TRANSFER_WITH_MEMO_SELECTOR], recipients: PAYEES, otherTargets: [] },
    });
  });

  it('throws on a malformed account or the wrong chain, since there is nothing to report', async () => {
    const { rail, chain } = setup();
    await expect(rail.remaining('nope')).rejects.toThrow(TempoRailError);
    chain.wrongChain = true;
    await expect(rail.keyStatus(ROOT)).rejects.toThrow(/chain 4217/);
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
      if (chain.signed.length === 1) chain.nonce = 1;
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
});

describe('safety probes', () => {
  it('lands a transfer above the limit and reads back the keychain\'s refusal', async () => {
    const { rail, chain } = setup();
    const result = await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] });
    expect(result).toEqual({ tx: chain.broadcasts[0], includedOnChain: true, reverted: true, reason: 'SpendingLimitExceeded', returnData: '0x8a9e71ea', gasUsed: 70_000n, error: null });
    expect(decodeFunctionData({ abi: Abis.tip20, data: chain.signed[0]!.calls[0]!.data }).args).toEqual([PAYEES[0], 10_000_001n, memoBytes('HF-PROBE-OVER-LIMIT')]);
    expect(chain.rootBalance).toBe(1_000_000_000n);
    expect((await rail.remaining(ROOT)).remaining).toBe(10_000_000n);
  });

  it('lands a plain transfer and reads back the scope refusal', async () => {
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
    // A keychain that fails to enforce: the over-limit transfer goes through.
    chain.key = { ...chain.key, enforceLimits: false };
    const status = chain.keyState.bind(chain);
    chain.keyState = async () => ({ ...(await status()), enforceLimits: true });
    expect(await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({ includedOnChain: true, reverted: false, reason: null, error: null });

    const dropped = setup();
    dropped.chain.onBroadcast = 'drop';
    expect(await dropped.rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).toMatchObject({
      tx: dropped.chain.broadcasts[0],
      includedOnChain: false,
      reverted: false,
      error: 'the probe was not included before it expired',
    });
  });

  it('does not send a probe that would prove the wrong thing or move funds', async () => {
    const { rail, chain } = setup();
    expect((await rail.probeOverLimit({ account: ROOT, to: OUTSIDER })).error).toContain("is outside the key's scope");
    chain.key = { ...chain.key, scopes: [{ target: TOKEN, selectorRules: [] }] };
    expect((await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER })).error).toContain("the key's scope allows a plain transfer");
    chain.key = { ...chain.key, isScoped: false, scopes: [] };
    expect((await rail.probeOutOfScope({ account: ROOT, to: OUTSIDER })).error).toContain("the key's scope allows a plain transfer");
    chain.key = { ...chain.key, enforceLimits: false };
    expect((await rail.probeOverLimit({ account: ROOT, to: PAYEES[0] })).error).toBe('the key has no spending limit to exceed');
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
  const root = Account.fromSecp256k1(generatePrivateKey());

  async function signedWire(accessKeyAddress: Hex, over: Partial<Parameters<typeof buildAccessKeyAuthorization>[0]> = {}): Promise<Hex> {
    const request = buildAccessKeyAuthorization({
      rootAddress: root.address,
      accessKeyAddress,
      token: TOKEN,
      limit: 10_000_000n,
      periodSeconds: 3_600,
      expiry: START + 86_400,
      recipients: PAYEES,
      chainId: 42431,
      ...over,
    });
    return serializeSignedAuthorization(request.authorization, await root.sign({ hash: request.signPayload }));
  }

  it('provisions the key with a zero transfer to the first listed payee', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address) });
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0], error: null });
    const tx = chain.signed[0]!;
    expect(tx.keyAuthorization?.address.toLowerCase()).toBe(accessKey.address.toLowerCase());
    expect(tx.calls.map((call) => decodeFunctionData({ abi: Abis.tip20, data: call.data }).args)).toEqual([[PAYEES[0], 0n, memoBytes('HF-KEY-AUTHORIZED')]]);
    expect(await rail.keyStatus(ROOT)).toMatchObject({ authorized: true, remaining: 10_000_000n });
  });

  it('sends the zero transfer to the account itself when the key may pay anyone', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const wire = await signedWire(accessKey.address, { recipients: [] });
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: wire })).ok).toBe(true);
    expect(decodeFunctionData({ abi: Abis.tip20, data: chain.signed[0]!.calls[0]!.data }).args).toEqual([ROOT, 0n, memoBytes('HF-KEY-AUTHORIZED')]);
  });

  it('provisions the key and pays the first run in one transaction', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address), firstRun: { lines, runId: RUN } });
    expect(result).toMatchObject({ ok: true, tx: chain.broadcasts[0] });
    expect(chain.signed).toHaveLength(1);
    expect(chain.signed[0]!.calls).toHaveLength(3);
    expect((await rail.remaining(ROOT)).remaining).toBe(5_750_000n);
    expect(await rail.pay(run)).toMatchObject({ ok: true, tx: result.tx, alreadyPaid: true });
  });

  it('checks the first run against the authorization before sending', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const small = await signedWire(accessKey.address, { limit: 4_000_000n });
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: small, firstRun: { lines, runId: RUN } });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toContain('the run totals 4.25 but the key may only spend 4.00 more');
    const narrow = await signedWire(accessKey.address, { recipients: PAYEES.slice(0, 2) });
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: narrow, firstRun: { lines, runId: RUN } })).error).toContain("line 3: 0x166EAfA209a18A105D592c726d21e19D2ad37568 is not on the key's recipient allow-list");
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses an authorization that has already expired on chain time', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address, { expiry: START - 10 }) });
    expect(result).toMatchObject({ ok: false, tx: null });
    expect(result.error).toMatch(/ expired at 2026-10-10T/);
    expect(chain.signed).toHaveLength(0);
  });

  it('refuses an authorization for another key, chain or token', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const other = Account.fromP256(generatePrivateKey()).address;
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(other) })).error).toContain('the authorization is for key');
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address, { chainId: 4217 }) })).error).toBe('the authorization is for chain 4217, this rail runs on chain 42431');
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address, { token: TOKENS.moderato.BetaUSD }) })).error).toContain('does not allow transferWithMemo on');
    expect((await rail.submitAuthorization({ account: ROOT, signedWire: '0x1234' })).error).toContain('the authorization cannot be read');
    expect((await rail.submitAuthorization({ account: 'nope', signedWire: '0x' })).error).toContain('is not a valid address');
    expect(chain.signed).toHaveLength(0);
  });

  it('has nothing to do for a key that is already authorized, and pays the first run through the normal path', async () => {
    const { rail, chain, accessKey } = setup();
    const wire = await signedWire(accessKey.address);
    expect(await rail.submitAuthorization({ account: ROOT, signedWire: wire })).toEqual({ ok: true, tx: null, error: null, alreadyPaid: false, gasUsed: null });
    expect(chain.signed).toHaveLength(0);
    expect(await rail.submitAuthorization({ account: ROOT, signedWire: wire, firstRun: { lines, runId: RUN } })).toMatchObject({ ok: true, alreadyPaid: false });
    expect(chain.signed[0]!.keyAuthorization).toBeUndefined();
  });

  it('refuses an account that is its own fee sponsor, with or without a first run', async () => {
    const { rail, chain, accessKey } = setup();
    chain.forget();
    const wire = await signedWire(accessKey.address);
    const expected = { ok: false, tx: null, error: 'the fee sponsor must be a different account from the one paying out' };
    expect(await rail.submitAuthorization({ account: rail.sponsorAddress, signedWire: wire })).toMatchObject(expected);
    expect(await rail.submitAuthorization({ account: rail.sponsorAddress, signedWire: wire, firstRun: { lines, runId: RUN } })).toMatchObject(expected);
    expect(chain.signed).toHaveLength(0);
  });

  it('returns a refusal instead of throwing when called standalone with a bad configuration', async () => {
    const config = { network: 'moderato' as const, token: TOKEN, accessKeyPrivateKey: '0x12' as Hex, sponsorPrivateKey: generatePrivateKey() };
    expect(await submitAuthorization(config, { account: ROOT, signedWire: '0x' })).toEqual({
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
    const result = await rail.submitAuthorization({ account: ROOT, signedWire: await signedWire(accessKey.address) });
    expect(result.error).toContain('a revoked key can never be authorized again');
    expect(chain.signed).toHaveLength(0);
  });
});
