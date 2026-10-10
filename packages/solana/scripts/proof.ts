import assert from 'node:assert/strict';
import type { PayoutLine } from '@holdfast/core';
import { getBase64Encoder, MAX_SUPPORTED_TRANSACTION_VERSION, signature as toSignature } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { sleep } from '../src/confirm';
import { connect, type SolanaRpc } from '../src/connection';
import {
  associatedTokenAddress,
  buildDelegateApproval,
  buildDelegateRevoke,
  createSolanaPayoutRail,
  formatBaseUnits,
  toBaseUnits,
  type AllowanceProbe,
  type PayoutPreview,
  type PayoutRun,
  type SolanaPayoutResult,
} from '../src/index';
import { signAndSendAsWallet, submit } from './chain';
import { fundAll, type FundingRecord } from './funding';
import { loadOrCreateKeys } from './keys';
import { patientTransport } from './transport';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DECIMALS = 6;
const RUN_ID = 'HF-2026-10-0001';

export type Cluster = 'devnet' | 'localnet';

export interface ProofStep {
  title: string;
  signature: string | null;
  notes: string[];
}

export interface ProofReport {
  cluster: Cluster;
  rpcUrl: string;
  nodeVersion: string;
  owner: string;
  delegate: string;
  mint: string;
  ownerTokenAccount: string;
  recipients: string[];
  funding: FundingRecord[];
  steps: ProofStep[];
  remainingAfterApproval: bigint;
  priced: PayoutPreview;
  refusedOverAccountLimit: SolanaPayoutResult;
  remainingAfterRun: bigint;
  payout: SolanaPayoutResult;
  run: PayoutRun;
  replay: SolanaPayoutResult;
  replayAfterRestart: SolanaPayoutResult;
  refusedDifferentLines: SolanaPayoutResult;
  refusedBeforeSending: SolanaPayoutResult;
  probe: AllowanceProbe;
  probeAtNewAddress: AllowanceProbe;
  selfProbe: AllowanceProbe;
  remainingAfterRevoke: bigint;
  refusedAfterRevoke: SolanaPayoutResult;
  probeAfterRevoke: AllowanceProbe;
}

export interface ProofOptions {
  rpcUrl: string;
  /** Where the throwaway keys are kept between runs. */
  keysFile: string;
  log?: (line: string) => void;
}

async function identifyCluster(rpc: SolanaRpc, rpcUrl: string): Promise<Cluster> {
  const genesisHash = await rpc.getGenesisHash().send();
  if (genesisHash === DEVNET_GENESIS_HASH) return 'devnet';
  const { hostname } = new URL(rpcUrl);
  if (hostname === '127.0.0.1' || hostname === 'localhost') return 'localnet';
  throw new Error(`refusing to run against genesis ${genesisHash}: the proof runs on devnet or a local validator only`);
}

/**
 * Poll a read until it shows what the last transaction should have caused.
 * The nodes behind a public endpoint lag one another by a slot or two.
 */
async function eventually<T>(read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 15 && !settled(value); attempt++) {
    await sleep(1_500);
    value = await read();
  }
  return value;
}

/** Facts about a landed transaction, quoted from the node rather than from our own bookkeeping. */
async function describeOnChain(rpc: SolanaRpc, signature: string): Promise<string[]> {
  const response = await eventually(
    () =>
      rpc
        .getTransaction(toSignature(signature), {
          commitment: 'confirmed',
          encoding: 'base64',
          maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        })
        .send(),
    found => found !== null,
  );
  if (!response?.meta) return ['the node did not return this transaction'];
  const { meta } = response;
  const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item));
  const notes = [
    `meta.err: \`${json(meta.err)}\``,
    `${getBase64Encoder().encode(response.transaction[0]).length} bytes, fee ${meta.fee} lamports, ` +
      `${meta.computeUnitsConsumed ?? 'unknown'} compute units`,
  ];
  if (meta.err !== null) {
    const failures = (meta.logMessages ?? []).filter(line => /failed|error/i.test(line));
    notes.push(...failures.map(line => `log: \`${line}\``));
  }
  return notes;
}

export async function runProof(options: ProofOptions): Promise<ProofReport> {
  const { rpcUrl } = options;
  const node = { rpcUrl, transport: patientTransport(rpcUrl) };
  const rpc = connect(node);
  const cluster = await identifyCluster(rpc, rpcUrl);
  const nodeVersion = (await rpc.getVersion().send())['solana-core'];
  const { owner, delegate, delegateSecretKey, mint, recipients } = await loadOrCreateKeys(options.keysFile, 4);
  const ownerTokenAccount = await associatedTokenAddress(owner.address, mint.address);
  // Three payees, and a fourth address that never gets a token account.
  const [first, second, third, stranger] = recipients.map(recipient => recipient.address);
  assert.ok(first && second && third && stranger);
  const amount = (decimal: string): bigint => toBaseUnits(decimal, DECIMALS);
  const show = (units: bigint): string => formatBaseUnits(units, DECIMALS);

  const steps: ProofStep[] = [];
  const step = (title: string, signature: string | null, notes: string[] = []): void => {
    steps.push({ title, signature, notes });
    options.log?.([`${steps.length}. ${title}`, ...(signature ? [signature] : []), ...notes].join('\n   '));
  };

  options.log?.(`cluster ${cluster} (${nodeVersion}), owner ${owner.address}, delegate ${delegate.address}`);
  const funding = await fundAll(rpc, rpcUrl, [owner, delegate]);
  for (const record of funding) {
    const role = record.address === owner.address ? 'owner' : 'delegate';
    step(
      `Fund ${role} with SOL: ${record.method}`,
      record.signature,
      record.refusals.map(refusal => `refused first: ${refusal}`),
    );
  }

  const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
  const mintSignature = await submit(rpc, owner, [
    getCreateAccountInstruction({
      payer: owner,
      newAccount: mint,
      lamports: mintRent,
      space: getMintSize(),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: owner.address }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer: owner,
      ata: ownerTokenAccount,
      owner: owner.address,
      mint: mint.address,
    }),
    getMintToCheckedInstruction({
      mint: mint.address,
      token: ownerTokenAccount,
      mintAuthority: owner,
      amount: amount('100'),
      decimals: DECIMALS,
    }),
  ]);
  step('Create a 6-decimal test mint standing in for USDC and mint 100.00 to the owner', mintSignature, [
    `mint ${mint.address}`,
    `owner token account ${ownerTokenAccount}`,
  ]);

  const railConfig = { ...node, mint: mint.address, decimals: DECIMALS, delegateSecretKey };
  const rail = createSolanaPayoutRail(railConfig);
  const remaining = async (expected: bigint): Promise<bigint> =>
    eventually(async () => (await rail.remaining(owner.address)).remaining, value => value === expected);
  assert.equal(await rail.delegate(), delegate.address);
  assert.equal(await remaining(0n), 0n, 'nothing is delegated before the owner approves');

  const approval = await buildDelegateApproval({
    ...node,
    owner: owner.address,
    mint: mint.address,
    decimals: DECIMALS,
    delegate: await rail.delegate(),
    amount: amount('10'),
  });
  const approvalSignature = await signAndSendAsWallet(rpc, owner, approval);
  const remainingAfterApproval = await remaining(amount('10'));
  assert.equal(remainingAfterApproval, amount('10'));
  step('Owner signs the approval built by buildDelegateApproval: delegate may move 10.00', approvalSignature, [
    `summary shown to the owner: ${JSON.stringify(approval.summary)}`,
    `remaining() = ${show(remainingAfterApproval)}`,
  ]);

  const lines: PayoutLine[] = [
    { to: first, amount: amount('1'), memo: 'INV-1041 design retainer' },
    { to: second, amount: amount('2.5'), memo: 'INV-1042 audit milestone 2' },
    { to: third, amount: amount('0.75'), memo: 'INV-1043 translation' },
  ];
  const run1 = { account: owner.address, lines, runId: RUN_ID };

  const priced = await rail.preview(run1);
  assert.ok(priced.ok && priced.cost, `preview turned the run down: ${priced.error}`);
  assert.equal(priced.cost.newTokenAccounts, 3);
  step('preview() prices the run before anything is sent', null, [
    `${priced.cost.newTokenAccounts} payee token accounts to create: ${priced.cost.rentLamports} lamports of rent ` +
      `from the delegate, plus a fee of ${priced.cost.feeLamports} lamports`,
  ]);

  const refusedOverAccountLimit = await rail.pay({
    account: owner.address,
    lines: [...lines, { to: stranger, amount: amount('0.01'), memo: 'one new account too many' }],
    runId: 'HF-2026-10-0009',
  });
  assert.equal(refusedOverAccountLimit.outcome, 'refused');
  assert.match(refusedOverAccountLimit.error ?? '', /^run would create 4 payee token accounts/);
  step('pay() refuses a run that would create four token accounts; the limit per run is three', null, [
    `error: ${refusedOverAccountLimit.error}`,
  ]);

  const payout = await rail.pay(run1);
  assert.ok(payout.outcome === 'paid' && payout.tx, `payout failed: ${payout.error}`);
  const remainingAfterRun = await remaining(amount('5.75'));
  assert.equal(remainingAfterRun, amount('5.75'));
  step(`Delegate pays run ${RUN_ID}: 1.00 + 2.50 + 0.75 to three new recipients, one transaction`, payout.tx, [
    ...(await describeOnChain(rpc, payout.tx)),
    `outcome ${payout.outcome}, line memos on chain: ${payout.lineMemos}`,
    `remaining() = ${show(remainingAfterRun)}`,
  ]);

  const run = await eventually(() => rail.findRun(owner.address, RUN_ID), found => found !== null);
  assert.ok(run, 'the run is found by its memo');
  assert.equal(run.signature, payout.tx);
  assert.deepEqual(
    run.transfers.map(({ to, amount: paid, memo }) => ({ to, amount: paid, memo })),
    lines,
  );
  const history = await rpc.getSignaturesForAddress(ownerTokenAccount, { limit: 1 }).send();
  step('findRun rebuilds the run from chain data alone', null, [
    `getSignaturesForAddress memo field: \`${history[0]?.memo}\``,
    ...run.transfers.map(transfer => `${show(transfer.amount)} to ${transfer.to} "${transfer.memo}"`),
    `total ${show(run.total)}`,
  ]);

  const replay = await rail.pay(run1);
  assert.ok(replay.ok && replay.replayed, `the replay was not recognised: ${replay.error}`);
  assert.equal(replay.tx, payout.tx);
  // A rail that starts afresh has only the chain to go by. Let it see the run
  // there before it is asked to pay, as a service coming back up would.
  const restarted = createSolanaPayoutRail(railConfig);
  const seen = await eventually(() => restarted.preview(run1), preview => preview.paidBy !== null);
  assert.equal(seen.paidBy, payout.tx);
  const replayAfterRestart = await restarted.pay(run1);
  assert.ok(replayAfterRestart.ok && replayAfterRestart.replayed);
  assert.equal(replayAfterRestart.tx, payout.tx);
  assert.equal(await remaining(remainingAfterRun), remainingAfterRun, 'a replay pays nothing');
  step('pay() called again with the same run returns the first transaction and sends nothing', null, [
    `same rail: outcome ${replay.outcome}, replayed ${replay.replayed}, tx ${replay.tx}`,
    `a new rail on the same key, found on chain: replayed ${replayAfterRestart.replayed}, tx ${replayAfterRestart.tx}`,
    `remaining() = ${show(remainingAfterRun)}`,
  ]);

  const refusedDifferentLines = await rail.pay({
    ...run1,
    lines: lines.map((line, index) => (index === 0 ? { ...line, amount: amount('1.5') } : line)),
  });
  assert.equal(refusedDifferentLines.outcome, 'refused');
  assert.match(refusedDifferentLines.error ?? '', /was already paid by .* with different lines/);
  step('pay() refuses the same run id with different lines', null, [`error: ${refusedDifferentLines.error}`]);

  const refusedBeforeSending = await rail.pay({
    account: owner.address,
    lines: [{ to: first, amount: remainingAfterRun + 1n, memo: 'one base unit too many' }],
    runId: 'HF-2026-10-0002',
  });
  assert.equal(refusedBeforeSending.ok, false);
  assert.equal(refusedBeforeSending.tx, null);
  assert.match(refusedBeforeSending.error ?? '', /^exceeds delegated allowance/);
  step('pay() refuses a run above the allowance without sending anything', null, [
    `error: ${refusedBeforeSending.error}`,
  ]);

  const probe = await rail.probeOverAllowance({ account: owner.address, to: first });
  assert.ok(probe.failedOnChain && probe.signature, `the probe was not refused on chain: ${probe.error}`);
  assert.equal(await remaining(remainingAfterRun), remainingAfterRun, 'a refused transfer leaves the allowance alone');
  step(
    `probeOverAllowance sends ${show(remainingAfterRun + 1n)} with preflight skipped; the Token program refuses it`,
    probe.signature,
    [`reported: ${probe.error}`, ...(await describeOnChain(rpc, probe.signature))],
  );

  const probeAtNewAddress = await rail.probeOverAllowance({ account: owner.address, to: stranger });
  assert.equal(probeAtNewAddress.signature, null);
  assert.match(probeAtNewAddress.error ?? '', /the probe never creates one/);
  step('probeOverAllowance sends nothing at an address without a token account', null, [
    `reported: ${probeAtNewAddress.error}`,
  ]);

  const selfProbe = await rail.probeOverAllowance({ account: owner.address, to: owner.address });
  assert.ok(selfProbe.failedOnChain && selfProbe.signature, `the self probe was not refused: ${selfProbe.error}`);
  step('The same probe aimed at the owner itself, which could not move tokens even if it passed', selfProbe.signature, [
    `reported: ${selfProbe.error}`,
    ...(await describeOnChain(rpc, selfProbe.signature)),
  ]);

  const revoke = await buildDelegateRevoke({ ...node, owner: owner.address, mint: mint.address });
  const revokeSignature = await signAndSendAsWallet(rpc, owner, revoke);
  const remainingAfterRevoke = await remaining(0n);
  assert.equal(remainingAfterRevoke, 0n);
  step('Owner signs the revoke built by buildDelegateRevoke', revokeSignature, [
    `remaining() = ${show(remainingAfterRevoke)}`,
  ]);

  const refusedAfterRevoke = await rail.pay({
    account: owner.address,
    lines: [{ to: first, amount: amount('0.01'), memo: 'after revoke' }],
    runId: 'HF-2026-10-0003',
  });
  assert.equal(refusedAfterRevoke.ok, false);
  assert.equal(refusedAfterRevoke.tx, null);
  step('pay() is refused after the revoke', null, [`error: ${refusedAfterRevoke.error}`]);

  const probeAfterRevoke = await rail.probeOverAllowance({ account: owner.address, to: first });
  assert.ok(probeAfterRevoke.failedOnChain && probeAfterRevoke.signature, `not refused: ${probeAfterRevoke.error}`);
  step('A transfer of one base unit by the former delegate is refused on chain too', probeAfterRevoke.signature, [
    `reported: ${probeAfterRevoke.error}`,
    ...(await describeOnChain(rpc, probeAfterRevoke.signature)),
  ]);

  return {
    cluster,
    rpcUrl,
    nodeVersion,
    owner: owner.address,
    delegate: delegate.address,
    mint: mint.address,
    ownerTokenAccount,
    recipients: [first, second, third],
    funding,
    steps,
    remainingAfterApproval,
    priced,
    refusedOverAccountLimit,
    remainingAfterRun,
    payout,
    run,
    replay,
    replayAfterRestart,
    refusedDifferentLines,
    refusedBeforeSending,
    probe,
    probeAtNewAddress,
    selfProbe,
    remainingAfterRevoke,
    refusedAfterRevoke,
    probeAfterRevoke,
  };
}
