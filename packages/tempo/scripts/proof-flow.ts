import type { PayoutLine } from '@holdfast/core';
import type { Address, Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { tempoModerato } from 'viem/chains';
import { Abis, Account, createClient } from 'viem/tempo';
import {
  MAX_LINES_PER_RUN,
  NETWORKS,
  TOKENS,
  type TempoPayoutRail,
  buildAccessKeyAuthorization,
  buildRevoke,
  createTempoPayoutRail,
  explorerTxUrl,
  formatBaseUnits,
  generateAccessKey,
  lineMemo,
  serializeSignedAuthorization,
  toBaseUnits,
} from '../src/index';

/**
 * The whole life of a payout key on the Moderato testnet: a root authorizes
 * it, the rail pays with it, the keychain refuses what the key was not given,
 * the root takes it away. Everything after the authorization goes through the
 * package's public API. Testnet only: the funds come from the faucet.
 */

export interface ProofRow {
  step: string;
  result: string;
  gasUsed: bigint | null;
  tx: Hex | null;
}

export interface ProofKeys {
  network: 'moderato';
  createdAt: string;
  root: { address: Address; privateKey: Hex };
  sponsor: { address: Address; privateKey: Hex };
  accessKey: { address: Address; privateKey: Hex };
  secondAccessKey: { address: Address; privateKey: Hex };
  recipients: Address[];
  outsider: Address;
}

export interface ProofReport {
  startedAt: string;
  node: string;
  token: Address;
  keys: ProofKeys;
  rows: ProofRow[];
  funding: Hex[];
  /** Gas of the payout runs, by number of lines. */
  gas: { firstTimePayees3: bigint; knownPayees6: bigint; knownPayees32: bigint };
}

export interface ProofOptions {
  log?: (line: string) => void;
  /** Called as soon as the throwaway keys exist, before anything is sent. */
  onKeys?: (keys: ProofKeys) => void;
}

const TOKEN = TOKENS.moderato.AlphaUSD;
const NETWORK = 'moderato';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`proof failed: ${message}`);
}

export async function runModeratoProof(options: ProofOptions = {}): Promise<ProofReport> {
  const log = options.log ?? (() => undefined);
  const startedAt = new Date().toISOString();
  const rows: ProofRow[] = [];
  const record = (step: string, result: string, tx: Hex | null = null, gasUsed: bigint | null = null) => {
    rows.push({ step, result, gasUsed, tx });
    log(`\n[${rows.length}] ${step}\n    ${result}${gasUsed === null ? '' : `\n    gas used ${gasUsed}`}${tx ? `\n    ${explorerTxUrl(NETWORK, tx)}` : ''}`);
  };

  const reader = createClient({ chain: tempoModerato });
  const chainId = await reader.getChainId();
  check(chainId === NETWORKS.moderato.chainId && tempoModerato.testnet === true, `refusing to run on chain ${chainId}: this proof is for the Moderato testnet only`);
  const node = String(await reader.request({ method: 'web3_clientVersion' }));

  // The root stands in for the treasurer's passkey: it signs authorizations and the revocation, nothing else.
  const rootPrivateKey = generatePrivateKey();
  const rootAccount = Account.fromSecp256k1(rootPrivateKey);
  const sponsorPrivateKey = generatePrivateKey();
  const accessKey = generateAccessKey();
  const secondAccessKey = generateAccessKey();
  const recipients = [0, 1, 2].map(() => privateKeyToAddress(generatePrivateKey())) as [Address, Address, Address];
  const outsider = privateKeyToAddress(generatePrivateKey());
  const keys: ProofKeys = {
    network: NETWORK,
    createdAt: startedAt,
    root: { address: rootAccount.address, privateKey: rootPrivateKey },
    sponsor: { address: privateKeyToAddress(sponsorPrivateKey), privateKey: sponsorPrivateKey },
    accessKey,
    secondAccessKey,
    recipients,
    outsider,
  };
  options.onKeys?.(keys);
  const account = rootAccount.address;
  log(`node      ${node}\nroot      ${account}\nsponsor   ${keys.sponsor.address}\naccess key ${accessKey.address}\nrecipients ${recipients.join(', ')}`);

  const balanceOf = (owner: Address) => reader.readContract({ address: TOKEN, abi: Abis.tip20, functionName: 'balanceOf', args: [owner] });
  const expected = new Map<Address, bigint>(recipients.map((recipient) => [recipient, 0n]));
  const credit = (lines: PayoutLine[]) => {
    for (const line of lines) expected.set(line.to as Address, (expected.get(line.to as Address) ?? 0n) + line.amount);
  };

  // ---- funding
  const funding: Hex[] = [];
  for (const [label, address] of [
    ['root', account],
    ['sponsor', keys.sponsor.address],
  ] as const) {
    const receipts = await reader.faucet.fundSync({ account: address, timeout: 60_000 });
    funding.push(...receipts.map((receipt) => receipt.transactionHash));
    log(`funded ${label} from the faucet: ${formatBaseUnits(await balanceOf(address))} AlphaUSD`);
    for (const receipt of receipts) log(`    ${explorerTxUrl(NETWORK, receipt.transactionHash)}`);
  }

  const config = { network: NETWORK, token: TOKEN, sponsorPrivateKey } as const;
  const rail: TempoPayoutRail = createTempoPayoutRail({ ...config, accessKeyPrivateKey: accessKey.privateKey });
  const expiry = Math.floor(Date.now() / 1000) + 24 * 3600;
  const policy = { rootAddress: account, token: TOKEN, limit: toBaseUnits('10.00'), periodSeconds: 3600, expiry, recipients, chainId };

  // ---- the root authorizes the key: it signs one digest, the service submits it and the sponsor pays
  const request = buildAccessKeyAuthorization({ ...policy, accessKeyAddress: accessKey.address });
  const signedWire = serializeSignedAuthorization(request.authorization, await rootAccount.sign({ hash: request.signPayload }));
  const authorized = await rail.submitAuthorization({ account, signedWire, expected: { ...policy, accessKeyAddress: accessKey.address } });
  check(authorized.ok && authorized.tx !== null, `authorization failed: ${authorized.error}`);
  record('Root signs the key authorization (10.00 per 3600 s, transferWithMemo only, 3 recipients, expiry +24 h); the service submits it, the sponsor pays', 'key provisioned', authorized.tx, authorized.gasUsed);

  const status = await rail.keyStatus(account);
  check(status.authorized && status.live && status.mismatch.length === 0 && !status.revoked, 'the key is not authorized after the authorization landed');
  check(status.remaining === toBaseUnits('10.00'), `remaining after authorization is ${formatBaseUnits(status.remaining)}`);
  check(status.expiresAt === expiry * 1000, 'the key expiry differs from the one that was signed');
  check(status.scope.recipients?.length === 3 && status.scope.selectors?.length === 1 && status.scope.otherTargets.length === 0, 'the key scope differs from the one that was signed');
  record(
    'keyStatus',
    `authorized, remaining ${formatBaseUnits(status.remaining)}, window ends ${new Date(status.periodEnd ?? 0).toISOString()}, expires ${new Date(status.expiresAt).toISOString()}, scope: selector ${status.scope.selectors.join(',')} to ${status.scope.recipients.length} recipients`,
  );

  // ---- a three-line run
  const run1 = 'HF-2026-10-0001';
  const lines1 = ['1.00', '2.50', '0.75'].map((amount, i) => ({ to: recipients[i] as string, amount: toBaseUnits(amount), memo: lineMemo(run1, i + 1) }));
  const preflight1 = await rail.preflight({ account, lines: lines1, runId: run1 });
  check(preflight1.ok, `preflight refused the first run: ${preflight1.ok ? '' : preflight1.problems.join('; ')}`);
  record('preflight for run HF-2026-10-0001 (1.00 / 2.50 / 0.75)', 'ok');

  const paid1 = await rail.pay({ account, lines: lines1, runId: run1 });
  check(paid1.ok && paid1.tx !== null && paid1.gasUsed !== null && !paid1.alreadyPaid, `the first run failed: ${paid1.error}`);
  credit(lines1);
  record('pay run HF-2026-10-0001: 3 lines to first-time payees, fee paid by the sponsor', 'paid, one TransferWithMemo per line verified in the receipt', paid1.tx, paid1.gasUsed);

  const left1 = await rail.remaining(account);
  check(left1.remaining === toBaseUnits('5.75'), `remaining is ${formatBaseUnits(left1.remaining)}, expected exactly 5.75`);
  record('remaining', `${formatBaseUnits(left1.remaining)} of 10.00: the run cost the key exactly 4.25 and no fee`);

  const found1 = await rail.findRun(account, run1);
  check(found1 !== null && found1.tx === paid1.tx && found1.lines.length === 3 && found1.otherTxs.length === 0, 'findRun did not return the payout transaction');
  record('findRun HF-2026-10-0001, from chain logs alone', found1.lines.map((line) => `${line.memo} ${formatBaseUnits(line.amount)} -> ${line.to} (log ${line.logIndex})`).join('; '), found1.tx);

  const again = await rail.pay({ account, lines: lines1, runId: run1 });
  check(again.ok && again.alreadyPaid && again.tx === paid1.tx, `the repeated pay did not return the first transaction: ${again.error}`);
  check((await rail.remaining(account)).remaining === toBaseUnits('5.75'), 'the repeated pay moved the limit');
  record('pay run HF-2026-10-0001 again', 'nothing sent: the run was found on chain and its transaction returned; remaining still 5.75', again.tx);

  // ---- larger batches
  const run2 = 'HF-2026-10-0002';
  const lines2 = Array.from({ length: 6 }, (_, i) => ({ to: recipients[i % 3] as string, amount: toBaseUnits('0.25'), memo: lineMemo(run2, i + 1) }));
  const paid2 = await rail.pay({ account, lines: lines2, runId: run2 });
  check(paid2.ok && paid2.tx !== null && paid2.gasUsed !== null, `the six-line run failed: ${paid2.error}`);
  credit(lines2);
  record('pay run HF-2026-10-0002: 6 lines of 0.25 to known payees', 'paid', paid2.tx, paid2.gasUsed);

  const run3 = 'HF-2026-10-0003';
  const lines3 = Array.from({ length: MAX_LINES_PER_RUN }, (_, i) => ({ to: recipients[i % 3] as string, amount: toBaseUnits('0.01'), memo: lineMemo(run3, i + 1) }));
  const paid3 = await rail.pay({ account, lines: lines3, runId: run3 });
  check(paid3.ok && paid3.tx !== null && paid3.gasUsed !== null, `the 32-line run failed: ${paid3.error}`);
  credit(lines3);
  record(`pay run HF-2026-10-0003: ${MAX_LINES_PER_RUN} lines of 0.01, the most one transaction carries`, 'paid', paid3.tx, paid3.gasUsed);

  const tooMany = await rail.preflight({ account, lines: [...lines3, { to: recipients[0] as string, amount: 1n, memo: 'HF-2026-10-0004/33' }] });
  check(!tooMany.ok, 'preflight accepted 33 lines');
  record('preflight for 33 lines', `refused: ${tooMany.problems.join('; ')}`);

  const budget = toBaseUnits('10.00') - toBaseUnits('4.25') - toBaseUnits('1.50') - toBaseUnits('0.32');
  check((await rail.remaining(account)).remaining === budget, 'remaining after three runs is not 3.93');

  // ---- what the key cannot do, shown on chain
  const overLimit = await rail.probeOverLimit({ account, to: recipients[0] });
  check(overLimit.includedOnChain && overLimit.reverted && overLimit.tx !== null, `the over-limit probe did not fail on chain: ${overLimit.error}`);
  check(overLimit.reason === 'SpendingLimitExceeded', `the over-limit probe reverted with ${overLimit.reason} (${overLimit.returnData})`);
  record(`probeOverLimit: transferWithMemo of the largest amount there is, with ${formatBaseUnits(budget)} left, sent without simulation`, `included and reverted: ${overLimit.reason} (${overLimit.returnData})`, overLimit.tx, overLimit.gasUsed);

  const outOfScope = await rail.probeOutOfScope({ account, to: outsider });
  check(outOfScope.includedOnChain && outOfScope.reverted && outOfScope.tx !== null, `the out-of-scope probe did not fail on chain: ${outOfScope.error}`);
  check(outOfScope.reason === 'CallNotAllowed', `the out-of-scope probe reverted with ${outOfScope.reason} (${outOfScope.returnData})`);
  record('probeOutOfScope: plain transfer(address,uint256) of 0.000001, sent without simulation', `included and reverted: ${outOfScope.reason} (${outOfScope.returnData})`, outOfScope.tx, outOfScope.gasUsed);

  check((await rail.remaining(account)).remaining === budget, 'a probe moved the limit');
  check((await balanceOf(outsider)) === 0n, 'the out-of-scope probe paid the outsider');

  const run5 = 'HF-2026-10-0005';
  const lines5 = [0, 1, 2].map((i) => ({ to: recipients[i] as string, amount: toBaseUnits('2.00'), memo: lineMemo(run5, i + 1) }));
  const overBudget = await rail.pay({ account, lines: lines5, runId: run5 });
  check(!overBudget.ok && overBudget.tx === null && overBudget.error !== null, 'a run over the budget was not refused before sending');
  record('pay run HF-2026-10-0005: 6.00 with 3.93 left', `refused by preflight, nothing sent: ${overBudget.error}`);

  // ---- the root takes the key away
  const rootClient = createClient({ account: rootAccount, chain: tempoModerato });
  const revoked = await rootClient.sendTransactionSync({ calls: [buildRevoke({ accessKeyAddress: accessKey.address })], throwOnReceiptRevert: true });
  record('Root revokes the key (the call from buildRevoke, signed and paid by the root)', 'revoked', revoked.transactionHash, revoked.gasUsed);

  const afterRevoke = await rail.keyStatus(account);
  check(afterRevoke.revoked && !afterRevoke.authorized && afterRevoke.remaining === 0n, 'the key is not reported as revoked');
  const run6 = 'HF-2026-10-0006';
  const refused = await rail.pay({ account, lines: [{ to: recipients[0] as string, amount: toBaseUnits('0.10'), memo: lineMemo(run6, 1) }], runId: run6 });
  check(!refused.ok && refused.tx === null && /revoked/.test(refused.error ?? ''), `the revoked key was not refused: ${refused.error}`);
  record('pay run HF-2026-10-0006 with the revoked key', `refused, nothing sent: ${refused.error}`);

  // ---- the same account, a new key, provisioned together with its first run
  const secondRail = createTempoPayoutRail({ ...config, accessKeyPrivateKey: secondAccessKey.privateKey });
  const secondRequest = buildAccessKeyAuthorization({ ...policy, accessKeyAddress: secondAccessKey.address });
  const secondWire = serializeSignedAuthorization(secondRequest.authorization, await rootAccount.sign({ hash: secondRequest.signPayload }));
  const run7 = 'HF-2026-10-0007';
  const lines7 = [0, 1].map((i) => ({ to: recipients[i] as string, amount: toBaseUnits('0.50'), memo: lineMemo(run7, i + 1) }));
  const combined = await secondRail.submitAuthorization({ account, signedWire: secondWire, expected: { ...policy, accessKeyAddress: secondAccessKey.address }, firstRun: { lines: lines7, runId: run7 } });
  check(combined.ok && combined.tx !== null, `authorization with a first run failed: ${combined.error}`);
  credit(lines7);
  check((await secondRail.remaining(account)).remaining === toBaseUnits('9.00'), 'the second key did not spend exactly 1.00');
  record('A second key: root-signed authorization and run HF-2026-10-0007 (2 lines) in one transaction', 'key provisioned and run paid; remaining 9.00', combined.tx, combined.gasUsed);

  // ---- the books reconcile from chain data alone
  for (const [recipient, amount] of expected) {
    const balance = await balanceOf(recipient);
    check(balance === amount, `recipient ${recipient} holds ${formatBaseUnits(balance)}, the runs paid ${formatBaseUnits(amount)}`);
  }
  record('Recipient balances', recipients.map((recipient) => `${recipient} ${formatBaseUnits(expected.get(recipient) ?? 0n)}`).join('; ') + ': each equals the sum of its lines');

  return {
    startedAt,
    node,
    token: TOKEN,
    keys,
    rows,
    funding,
    gas: { firstTimePayees3: paid1.gasUsed, knownPayees6: paid2.gasUsed, knownPayees32: paid3.gasUsed },
  };
}

export function renderProof(report: ProofReport): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const { gas } = report;
  const lines = [
    '# Holdfast payout rail on Tempo Moderato',
    '',
    `Run started ${report.startedAt} against ${report.node}, chain ${NETWORKS.moderato.chainId}. Testnet only: funds are from the faucet and every key is throwaway.`,
    '',
    `- Account (root): \`${report.keys.root.address}\``,
    `- Fee sponsor: \`${report.keys.sponsor.address}\``,
    `- Access key: \`${report.keys.accessKey.address}\`, second access key: \`${report.keys.secondAccessKey.address}\``,
    `- Payout token: AlphaUSD \`${report.token}\``,
    '',
    '| # | Step | Result | Gas used | Transaction |',
    '|---|---|---|---|---|',
    ...report.rows.map((row, i) => `| ${i + 1} | ${cell(row.step)} | ${cell(row.result)} | ${row.gasUsed ?? ''} | ${row.tx ? `[${row.tx}](${explorerTxUrl(NETWORK, row.tx)})` : ''} |`),
    '',
    '## Gas',
    '',
    `- 3 lines to first-time payees: ${gas.firstTimePayees3} (${gas.firstTimePayees3 / 3n} per line)`,
    `- 6 lines to known payees: ${gas.knownPayees6} (${gas.knownPayees6 / 6n} per line)`,
    `- ${MAX_LINES_PER_RUN} lines to known payees: ${gas.knownPayees32} (${gas.knownPayees32 / BigInt(MAX_LINES_PER_RUN)} per line)`,
    `- each further line to a known payee: ${(gas.knownPayees32 - gas.knownPayees6) / BigInt(MAX_LINES_PER_RUN - 6)}`,
    '',
    '## Faucet funding',
    '',
    ...report.funding.map((hash) => `- ${explorerTxUrl(NETWORK, hash)}`),
    '',
  ];
  return lines.join('\n');
}
