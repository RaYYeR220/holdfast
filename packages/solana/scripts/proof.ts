import assert from 'node:assert/strict';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { connect, type SolanaRpc } from '../src/connection';
import {
  associatedTokenAddress,
  buildDelegateApproval,
  createSolanaPayoutRail,
  formatBaseUnits,
  toBaseUnits,
} from '../src/index';
import { signAndSendAsWallet, submit, type RefusedOnChain } from './chain';
import { fundAll, type FundingRecord } from './funding';
import { loadOrCreateKeys } from './keys';
import { describeMarker, readMarker, type MarkerState } from './marker-checks';
import { proveAllowance, type AllowanceProof } from './prove-allowance';
import { proveMarker, type MarkerProof } from './prove-marker';
import { proveRun, RUN_ID, type RunProof } from './prove-run';
import { eventually, readLanded, type ProofStep, type Proving } from './proving';
import { patientTransport } from './transport';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DECIMALS = 6;

export type Cluster = 'devnet' | 'localnet';
export type { ProofStep } from './proving';

export interface ProofReport extends RunProof, MarkerProof, AllowanceProof {
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
  /** What the marker of the first run held when everything else had been tried on it. */
  markerAtEnd: MarkerState;
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
 * The whole proof: fund the keys, make a mint, have the owner approve the
 * delegate, and then show in turn a run being paid once, what the chain
 * does with its marker, and the allowance as a limit that a revoke ends.
 */
export async function runProof(options: ProofOptions): Promise<ProofReport> {
  const { rpcUrl } = options;
  const node = { rpcUrl, transport: patientTransport(rpcUrl) };
  const rpc = connect(node);
  const cluster = await identifyCluster(rpc, rpcUrl);
  const nodeVersion = (await rpc.getVersion().send())['solana-core'];
  const { owner, delegate, delegateSecretKey, mint, recipients } = await loadOrCreateKeys(options.keysFile, 4);
  const ownerTokenAccount = await associatedTokenAddress(owner.address, mint.address);
  const [first, second, third, newcomer] = recipients.map(recipient => recipient.address);
  assert.ok(first && second && third && newcomer);
  const amount = (decimal: string): bigint => toBaseUnits(decimal, DECIMALS);
  const show = (units: bigint): string => formatBaseUnits(units, DECIMALS);

  const steps: ProofStep[] = [];
  const step = (title: string, signature: string | null, notes: string[] = []): void => {
    steps.push({ title, signature, notes });
    options.log?.([`${steps.length}. ${title}`, ...(signature ? [signature] : []), ...notes].join('\n   '));
  };
  const refusedStep = async (title: string, refusal: RefusedOnChain): Promise<void> =>
    step(title, refusal.signature, [`reported: ${refusal.error}`, ...(await readLanded(rpc, refusal.signature)).notes]);

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

  const proving: Proving = {
    rpc,
    node,
    railConfig,
    rail,
    owner,
    delegate,
    mint: mint.address,
    payees: [first, second, third],
    newcomer,
    amount,
    show,
    remaining,
    step,
    refusedStep,
  };
  const { paid, marker, proof: runProof } = await proveRun(proving);
  const markerProof = await proveMarker(proving, paid, marker, runProof.remainingAfterRun);
  const allowanceProof = await proveAllowance(proving, markerProof.remainingAfterRace);

  const markerAtEnd = await readMarker(rpc, marker.address);
  assert.deepEqual(markerAtEnd, runProof.marker.afterPayout);
  step(`The marker of run ${RUN_ID} after all of the above is as the payout left it`, null, [
    `run marker ${marker.address}: ${describeMarker(markerAtEnd)}`,
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
    ...runProof,
    ...markerProof,
    ...allowanceProof,
    markerAtEnd,
  };
}
