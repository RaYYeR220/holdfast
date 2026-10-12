import { TxEnvelopeTempo } from 'ox/tempo';
import type { Address, Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, Account, P256, createClient } from 'viem/tempo';
import {
  NETWORKS,
  type RevocationRequest,
  TOKENS,
  buildAccessKeyAuthorization,
  buildRevoke,
  createTempoPayoutRail,
  explorerTxUrl,
  formatBaseUnits,
  generateAccessKey,
  lineMemo,
  serializeSignedAuthorization,
  sponsorRevocation,
  toBaseUnits,
} from '../src/index';

/**
 * Taking an access key back on the Moderato testnet, the way the application
 * does it: the root is a passkey that holds no tokens at all, it signs the
 * revocation the rail prepared, and the rail's sponsor pays for it. Along the
 * way it shows what does not work: a revocation the root signed to pay for
 * itself cannot be given a fee payer afterwards. Testnet only: the funds come
 * from the faucet and every key is made here and thrown away.
 */

export interface RevocationRow {
  step: string;
  result: string;
  gasUsed: bigint | null;
  tx: Hex | null;
}

export interface RevocationKeys {
  network: 'moderato';
  createdAt: string;
  /** The root is a software passkey: a P-256 key that signs WebAuthn assertions. */
  root: { address: Address; privateKey: Hex; rpId: string; origin: string };
  sponsor: { address: Address; privateKey: Hex };
  accessKey: { address: Address; privateKey: Hex };
  secondAccessKey: { address: Address; privateKey: Hex };
}

export interface RevocationReport {
  startedAt: string;
  node: string;
  token: Address;
  keys: RevocationKeys;
  rows: RevocationRow[];
  funding: Hex[];
  /** Gas of the two revocations: the account's first transaction of its own, and its second. */
  gas: { first: bigint; second: bigint };
  /** What the sponsor paid for the two revocations together, in fee-token base units. */
  sponsorPaid: bigint;
}

export interface RevocationOptions {
  log?: (line: string) => void;
  /** Called as soon as the throwaway keys exist, before anything is sent. */
  onKeys?: (keys: RevocationKeys) => void;
}

const TOKEN = TOKENS.moderato.AlphaUSD;
const NETWORK = 'moderato';
const RP_ID = 'app.holdfast.example';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`proof failed: ${message}`);
}

export async function runRevocationProof(options: RevocationOptions = {}): Promise<RevocationReport> {
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const rows: RevocationRow[] = [];
  const record = (step: string, result: string, tx: Hex | null = null, gasUsed: bigint | null = null) => {
    rows.push({ step, result, gasUsed, tx });
    log(`\n[${rows.length}] ${step}\n    ${result}${gasUsed === null ? '' : `\n    gas used ${gasUsed}`}${tx ? `\n    ${explorerTxUrl(NETWORK, tx)}` : ''}`);
  };

  const reader = createClient({ chain: tempoModerato });
  const chainId = await reader.getChainId();
  check(chainId === NETWORKS.moderato.chainId && tempoModerato.testnet === true, `refusing to run on chain ${chainId}: this proof is for the Moderato testnet only`);
  const node = String(await reader.request({ method: 'web3_clientVersion' }));

  const rootPrivateKey = P256.randomPrivateKey();
  const origin = `https://${RP_ID}`;
  const root = Account.fromHeadlessWebAuthn(rootPrivateKey, { rpId: RP_ID, origin });
  const sponsorPrivateKey = generatePrivateKey();
  const sponsor = Account.fromSecp256k1(sponsorPrivateKey);
  const accessKey = generateAccessKey();
  const secondAccessKey = generateAccessKey();
  const keys: RevocationKeys = {
    network: NETWORK,
    createdAt: startedAt,
    root: { address: root.address, privateKey: rootPrivateKey, rpId: RP_ID, origin },
    sponsor: { address: sponsor.address, privateKey: sponsorPrivateKey },
    accessKey,
    secondAccessKey,
  };
  options.onKeys?.(keys);
  const account = root.address;
  log(`node       ${node}\nroot       ${account} (passkey)\nsponsor    ${sponsor.address}\naccess key ${accessKey.address}`);

  const balanceOf = (owner: Address) => reader.readContract({ address: TOKEN, abi: Abis.tip20, functionName: 'balanceOf', args: [owner] });

  // ---- funding: the sponsor alone. The root is never given anything.
  const receipts = await reader.faucet.fundSync({ account: sponsor.address, timeout: 60_000 });
  const funding = receipts.map((receipt) => receipt.transactionHash);
  log(`funded the sponsor from the faucet: ${formatBaseUnits(await balanceOf(sponsor.address))} AlphaUSD; the root holds ${formatBaseUnits(await balanceOf(account))}`);
  check((await balanceOf(account)) === 0n, 'the root holds tokens before anything was done');

  const config = { network: NETWORK, token: TOKEN, sponsorPrivateKey } as const;
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const policy = { rootAddress: account, token: TOKEN, limit: toBaseUnits('1.00'), periodSeconds: 3600, expiry, chainId };

  /** Authorize a key on the root's account: the root signs one digest, the rail submits it, the sponsor pays. */
  async function authorize(key: { address: Address; privateKey: Hex }) {
    const rail = createTempoPayoutRail({ ...config, accessKeyPrivateKey: key.privateKey });
    const expected = { ...policy, accessKeyAddress: key.address };
    const request = buildAccessKeyAuthorization(expected);
    const signedWire = serializeSignedAuthorization(request.authorization, await root.sign({ hash: request.signPayload }));
    const authorized = await rail.submitAuthorization({ account, signedWire, expected });
    check(authorized.ok && authorized.tx !== null, `authorization failed: ${authorized.error}`);
    check((await rail.keyStatus(account)).authorized, 'the key is not authorized after the authorization landed');
    return { rail, tx: authorized.tx, gasUsed: authorized.gasUsed };
  }

  /** What the root's wallet does with a prepared revocation: one `revokeKey` call, signed for a fee payer or, with `selfPaid`, for the account. */
  const sign = (request: RevocationRequest, selfPaid = false): Promise<Hex> =>
    root.signTransaction({
      type: 'tempo',
      chainId: request.chainId,
      calls: [buildRevoke({ accessKeyAddress: request.accessKey })],
      nonce: request.nonce,
      nonceKey: request.nonceKey,
      gas: request.gas,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      validBefore: request.validBefore,
      ...(selfPaid ? { feeToken: request.feeToken } : { feePayer: true as const }),
    });

  // ---- a key to take back
  const first = await authorize(accessKey);
  record('Passkey root (holding no tokens) signs a key authorization; the rail submits it, the sponsor pays', 'key authorized: 1.00 per 3600 s, transferWithMemo only', first.tx, first.gasUsed);

  const prepared = await first.rail.prepareRevocation(account);
  check(prepared.ok, `the rail prepared no revocation: ${prepared.ok ? '' : prepared.problems.join('; ')}`);
  const { request } = prepared;
  check(request.nonce === 0 && request.nonceKey === 0n && request.feePayer === sponsor.address, 'the prepared revocation is not on the account\'s own sequence with the sponsor paying');
  record(
    'prepareRevocation',
    `revokeKey(${request.accessKey}), nonce ${request.nonce} of the account's own sequence, gas limit ${request.gas}, at most ${request.maxFeePerGas} per gas, valid until ${new Date(request.validBefore * 1000).toISOString()}, fee payer ${request.feePayer}`,
  );

  // ---- what does not work: the root signs for a transaction it pays itself, and a sponsor is added afterwards
  const selfPaid = await sign(request, true);
  const turnedDown = await first.rail.submitRevocation({ account, signedTransaction: selfPaid });
  check(!turnedDown.ok && turnedDown.tx === null, 'the rail took a revocation the root signed to pay for itself');
  record('The root signs the same revocation without the fee payer marker; submitRevocation', `refused, nothing sent: ${turnedDown.error}`);

  const envelope = TxEnvelopeTempo.deserialize(selfPaid as TxEnvelopeTempo.Serialized);
  check(envelope.signature !== undefined, 'the self-paid transaction is not signed');
  const forced = await sponsorRevocation({ envelope: envelope as TxEnvelopeTempo.Signed, root: account, feeToken: TOKEN, sponsor });
  let nodeAnswer: string;
  try {
    await reader.request({ method: 'eth_sendRawTransaction', params: [forced.serialized] });
    nodeAnswer = 'accepted';
  } catch (error) {
    nodeAnswer = (error as { details?: string }).details ?? (error as Error).message.split('\n')[0] ?? 'rejected';
  }
  check(nodeAnswer !== 'accepted', 'the node took a fee payer\'s signature beside a sender\'s signature made without the marker');
  check((await reader.getTransactionCount({ address: account })) === 0, 'the rejected transaction used the root\'s nonce');
  record('The sponsor\'s signature is attached to that transaction all the same and sent to the node directly', `rejected by the node: ${nodeAnswer}`);
  check(!(await first.rail.keyStatus(account)).revoked, 'the key was revoked by a transaction the node rejected');

  // ---- what does: the root signs for a fee payer, the rail's sponsor signs after it
  const sponsorBefore = await balanceOf(sponsor.address);
  const revoked = await first.rail.submitRevocation({ account, signedTransaction: await sign(request) });
  check(revoked.ok && revoked.tx !== null && revoked.gasUsed !== null, `the revocation failed: ${revoked.error}`);
  const receipt = (await reader.getTransactionReceipt({ hash: revoked.tx })) as { from: Address; feePayer?: Address; feeToken?: Address; status: string };
  check(receipt.status === 'success' && receipt.from.toLowerCase() === account.toLowerCase(), 'the receipt is not that of the root\'s transaction');
  check(receipt.feePayer?.toLowerCase() === sponsor.address.toLowerCase(), `the receipt names ${receipt.feePayer} as fee payer, not the sponsor`);
  const paidFirst = sponsorBefore - (await balanceOf(sponsor.address));
  check(paidFirst > 0n && (await balanceOf(account)) === 0n, 'the fee was not taken from the sponsor alone');
  record(
    'The root signs the revocation with the fee payer marker; submitRevocation checks it, adds the sponsor\'s signature and sends it',
    `revoked; the receipt names the sponsor as fee payer, which paid ${formatBaseUnits(paidFirst)} AlphaUSD; the root still holds 0.00`,
    revoked.tx,
    revoked.gasUsed,
  );

  const status = await first.rail.keyStatus(account);
  check(status.revoked && !status.authorized && !status.live, 'the key is not reported as revoked');
  const nothing = await first.rail.prepareRevocation(account);
  check(!nothing.ok, 'the rail prepared a revocation for a revoked key');
  const run = 'HF-2026-10-0001';
  const refused = await first.rail.pay({ account, lines: [{ to: sponsor.address, amount: toBaseUnits('0.10'), memo: lineMemo(run, 1) }], runId: run });
  check(!refused.ok && refused.tx === null, 'the revoked key was not refused');
  record('keyStatus, prepareRevocation and pay with the revoked key', `revoked; ${nothing.ok ? '' : nothing.problems.join('; ')}; pay refused, nothing sent: ${refused.error}`);

  // ---- a second key on the same account: the account's nonce is no longer new state
  const second = await authorize(secondAccessKey);
  record('A second key is authorized on the same account', 'key authorized', second.tx, second.gasUsed);
  const again = await second.rail.prepareRevocation(account);
  check(again.ok && again.request.nonce === 1, 'the second revocation is not numbered after the first');
  const sponsorBeforeSecond = await balanceOf(sponsor.address);
  const revokedAgain = await second.rail.submitRevocation({ account, signedTransaction: await sign(again.request) });
  check(revokedAgain.ok && revokedAgain.tx !== null && revokedAgain.gasUsed !== null, `the second revocation failed: ${revokedAgain.error}`);
  const paidSecond = sponsorBeforeSecond - (await balanceOf(sponsor.address));
  check((await second.rail.keyStatus(account)).revoked && (await balanceOf(account)) === 0n, 'the second key is not revoked, or the root paid');
  record('The root revokes the second key the same way, at nonce 1', `revoked; the sponsor paid ${formatBaseUnits(paidSecond)} AlphaUSD`, revokedAgain.tx, revokedAgain.gasUsed);

  return { startedAt, node, token: TOKEN, keys, rows, funding, gas: { first: revoked.gasUsed, second: revokedAgain.gasUsed }, sponsorPaid: paidFirst + paidSecond };
}

export function renderRevocationProof(report: RevocationReport): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const lines = [
    '# Revoking a Holdfast access key on Tempo Moderato',
    '',
    `Run started ${report.startedAt} against ${report.node}, chain ${NETWORKS.moderato.chainId}. Testnet only: funds are from the faucet and every key is throwaway.`,
    '',
    `- Account (root, a passkey that was never funded): \`${report.keys.root.address}\``,
    `- Fee sponsor: \`${report.keys.sponsor.address}\``,
    `- Access key: \`${report.keys.accessKey.address}\`, second access key: \`${report.keys.secondAccessKey.address}\``,
    `- Fee token: AlphaUSD \`${report.token}\``,
    '',
    '| # | Step | Result | Gas used | Transaction |',
    '|---|---|---|---|---|',
    ...report.rows.map((row, i) => `| ${i + 1} | ${cell(row.step)} | ${cell(row.result)} | ${row.gasUsed ?? ''} | ${row.tx ? `[${row.tx}](${explorerTxUrl(NETWORK, row.tx)})` : ''} |`),
    '',
    '## Gas',
    '',
    `- revocation as the account's first transaction of its own: ${report.gas.first}`,
    `- revocation as its second: ${report.gas.second}`,
    `- the sponsor paid ${formatBaseUnits(report.sponsorPaid)} AlphaUSD for both; the root paid nothing and held nothing throughout`,
    '',
    '## Faucet funding',
    '',
    ...report.funding.map((hash) => `- ${explorerTxUrl(NETWORK, hash)}`),
    '',
  ];
  return lines.join('\n');
}
