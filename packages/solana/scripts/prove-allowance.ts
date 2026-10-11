import assert from 'node:assert/strict';
import { buildDelegateRevoke, type AllowanceProbe, type SolanaPayoutResult } from '../src/index';
import { signAndSendAsWallet } from './chain';
import { readLanded, type Proving } from './proving';

export interface AllowanceProof {
  refusedBeforeSending: SolanaPayoutResult;
  probe: AllowanceProbe;
  probeAtNewAddress: AllowanceProbe;
  selfProbe: AllowanceProbe;
  remainingAfterRevoke: bigint;
  refusedAfterRevoke: SolanaPayoutResult;
  probeAfterRevoke: AllowanceProbe;
}

/**
 * The allowance as a limit the chain holds the delegate to, and the revoke
 * that ends it. `allowance` is what the delegate may still move when this
 * starts.
 */
export async function proveAllowance(p: Proving, allowance: bigint): Promise<AllowanceProof> {
  const { rpc, rail, owner, show, step } = p;
  const [first] = p.payees;

  const refusedBeforeSending = await rail.pay({
    account: owner.address,
    lines: [{ to: first, amount: allowance + 1n, memo: 'one base unit too many' }],
    runId: 'HF-2026-10-0002',
    notBefore: p.since,
  });
  assert.equal(refusedBeforeSending.ok, false);
  assert.equal(refusedBeforeSending.tx, null);
  assert.match(refusedBeforeSending.error ?? '', /^exceeds delegated allowance/);
  step('pay() refuses a run above the allowance without sending anything', null, [
    `error: ${refusedBeforeSending.error}`,
  ]);

  const probe = await rail.probeOverAllowance({ account: owner.address, to: first });
  assert.ok(probe.failedOnChain && probe.signature, `the probe was not refused on chain: ${probe.error}`);
  assert.equal(await p.remaining(allowance), allowance, 'a refused transfer leaves the allowance alone');
  step(
    `probeOverAllowance sends ${show(allowance + 1n)} with preflight skipped; the Token program refuses it`,
    probe.signature,
    [`reported: ${probe.error}`, ...(await readLanded(rpc, probe.signature)).notes],
  );

  const probeAtNewAddress = await rail.probeOverAllowance({ account: owner.address, to: p.newcomer });
  assert.equal(probeAtNewAddress.signature, null);
  assert.match(probeAtNewAddress.error ?? '', /the probe never creates one/);
  step('probeOverAllowance sends nothing at an address without a token account', null, [
    `reported: ${probeAtNewAddress.error}`,
  ]);

  const selfProbe = await rail.probeOverAllowance({ account: owner.address, to: owner.address });
  assert.ok(selfProbe.failedOnChain && selfProbe.signature, `the self probe was not refused: ${selfProbe.error}`);
  step('The same probe aimed at the owner itself, which could not move tokens even if it passed', selfProbe.signature, [
    `reported: ${selfProbe.error}`,
    ...(await readLanded(rpc, selfProbe.signature)).notes,
  ]);

  const revoke = await buildDelegateRevoke({ ...p.node, owner: owner.address, mint: p.mint });
  const revokeSignature = await signAndSendAsWallet(rpc, owner, revoke);
  const remainingAfterRevoke = await p.remaining(0n);
  assert.equal(remainingAfterRevoke, 0n);
  step('Owner signs the revoke built by buildDelegateRevoke', revokeSignature, [
    `remaining() = ${show(remainingAfterRevoke)}`,
  ]);

  const refusedAfterRevoke = await rail.pay({
    account: owner.address,
    lines: [{ to: first, amount: p.amount('0.01'), memo: 'after revoke' }],
    runId: 'HF-2026-10-0003',
    notBefore: p.since,
  });
  assert.equal(refusedAfterRevoke.ok, false);
  assert.equal(refusedAfterRevoke.tx, null);
  step('pay() is refused after the revoke', null, [`error: ${refusedAfterRevoke.error}`]);

  const probeAfterRevoke = await rail.probeOverAllowance({ account: owner.address, to: first });
  assert.ok(probeAfterRevoke.failedOnChain && probeAfterRevoke.signature, `not refused: ${probeAfterRevoke.error}`);
  step('A transfer of one base unit by the former delegate is refused on chain too', probeAfterRevoke.signature, [
    `reported: ${probeAfterRevoke.error}`,
    ...(await readLanded(rpc, probeAfterRevoke.signature)).notes,
  ]);

  return {
    refusedBeforeSending,
    probe,
    probeAtNewAddress,
    selfProbe,
    remainingAfterRevoke,
    refusedAfterRevoke,
    probeAfterRevoke,
  };
}
