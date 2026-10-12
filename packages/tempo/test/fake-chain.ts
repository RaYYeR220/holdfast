import { KeyAuthorization } from 'ox/tempo';
import { type Address, type Hex, decodeFunctionData, encodeErrorResult, encodeEventTopics, isAddressEqual, keccak256, pad, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { Abis, Account, Addresses } from 'viem/tempo';
import {
  type AccessKeyPolicyInput,
  type BroadcastResult,
  CALL_NOT_ALLOWED,
  type ChainHead,
  type ChainLog,
  type ChainReceipt,
  type ForcedTx,
  type PayoutTx,
  type RawKeyState,
  type RevocationRequest,
  type RevocationTx,
  SPENDING_LIMIT_EXCEEDED,
  type SignedTx,
  TOKENS,
  TRANSFER_TOPIC,
  TRANSFER_WITH_MEMO_SELECTOR,
  TRANSFER_WITH_MEMO_TOPIC,
  type TempoChain,
  type TempoRailConfig,
  buildAccessKeyAuthorization,
  buildRevoke,
  createTempoPayoutRail,
  generateAccessKey,
  readSignedAuthorization,
  serializeSignedAuthorization,
} from '../src/index';

export const TOKEN = TOKENS.moderato.AlphaUSD;
/** The paying account. Its root is a throwaway key from public documentation; it never held funds anywhere. */
export const ROOT_ACCOUNT = Account.fromSecp256k1('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
export const ROOT: Address = ROOT_ACCOUNT.address;
export const PAYEES: [Address, Address, Address] = [
  '0x3c71213434d56CC8ACDe9Fb1c6b3d4920e40E19A',
  '0xF3009617E5A04f001Fc6839Def7A7f8A7ab4545b',
  '0x166EAfA209a18A105D592c726d21e19D2ad37568',
];
export const OUTSIDER: Address = '0x747a4BaeeaE8181AC988a67d3F2671ff3acdE0bC';
export const START = 1_791_640_000;

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const KEY_AUTHORIZED_TOPIC = encodeEventTopics({ abi: Abis.accountKeychain, eventName: 'KeyAuthorized' })[0] as Hex;
const KEY_REVOKED_TOPIC = encodeEventTopics({ abi: Abis.accountKeychain, eventName: 'KeyRevoked' })[0] as Hex;
/** What the keychain answers a `revokeKey` for a key the account does not hold. */
export const KEY_NOT_FOUND = encodeErrorResult({ abi: Abis.accountKeychain, errorName: 'KeyNotFound' });

type Decoded = { kind: 'memo'; to: Address; amount: bigint; memo: Hex } | { kind: 'plain'; to: Address; amount: bigint } | { kind: 'other' };

function decodeCall(data: Hex): Decoded {
  try {
    const call = decodeFunctionData({ abi: Abis.tip20, data });
    if (call.functionName === 'transferWithMemo') return { kind: 'memo', to: call.args[0], amount: call.args[1], memo: call.args[2] };
    if (call.functionName === 'transfer') return { kind: 'plain', to: call.args[0], amount: call.args[1] };
  } catch {
    // not a token call
  }
  return { kind: 'other' };
}

function nodeError(message: string, code: number, data?: Hex): Error {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

/**
 * An in-memory Tempo: one account, one access key, one token. It applies the
 * keychain's rules the way the node was observed to: scope before limit,
 * nothing transferred when a batch fails, a failed transaction still included,
 * a state read pinned to a block it does not have refused.
 */
export class FakeChain implements TempoChain {
  time = START;
  block = 5_000_000n;
  baseFee = 600_000_000n;
  /** Seconds the clock moves each time the head is read. */
  tick = 1;
  wrongChain = false;
  /** The account the key is held on: `ROOT` unless a test puts another in its place. */
  account: Address = ROOT;
  /** The key as the keychain holds it for `account`; every other account has never seen it. */
  key: RawKeyState;
  rootBalance = 1_000_000_000n;
  sponsorBalance = 1_000_000_000n;
  /** What the next broadcasts do. `lost` mines the transaction but fails the call, as a dropped response would. */
  onBroadcast: 'mine' | 'drop' | 'unreachable' | 'lost' = 'mine';
  /** Rewrites the logs of the next mined transaction. */
  tamper: ((logs: ChainLog[]) => ChainLog[]) | null = null;
  servesTraces = true;
  failing = new Set<keyof TempoChain>();
  readonly signed: PayoutTx[] = [];
  /** The revocations the sponsor was asked to sign for, in order. */
  readonly revocations: RevocationTx[] = [];
  readonly broadcasts: Hex[] = [];
  readonly receipts = new Map<Hex, ChainReceipt>();
  /** The block every nonce read was pinned to; null for an unpinned read. */
  readonly nonceReads: (bigint | null)[] = [];
  readonly searches: { fromBlock: bigint; toBlock: bigint }[] = [];
  private readonly built = new Map<Hex, { tx: PayoutTx; hash: Hex }>();
  private readonly builtRevocations = new Map<Hex, { tx: RevocationTx; hash: Hex }>();
  private readonly reverts = new Map<Hex, Hex>();
  private readonly lane: { block: bigint; nonce: number }[] = [{ block: 0n, nonce: 0 }];
  /** The account's own nonce sequence, which only what the root signs itself moves. */
  private readonly own: { block: bigint; nonce: number }[] = [{ block: 0n, nonce: 0 }];
  private logs: ChainLog[] = [];
  private logIndex = 0;

  constructor(
    readonly accessKey: Address,
    readonly sponsor: Address,
  ) {
    this.key = {
      keyId: accessKey,
      expiry: BigInt(START + 86_400),
      enforceLimits: true,
      isRevoked: false,
      remaining: 10_000_000n,
      periodEnd: BigInt(START + 3_600),
      isScoped: true,
      scopes: [{ target: TOKEN, selectorRules: [{ selector: TRANSFER_WITH_MEMO_SELECTOR, recipients: PAYEES }] }],
    };
  }

  get nonce(): number {
    return this.lane[this.lane.length - 1]?.nonce ?? 0;
  }

  /** Something takes the lane's next nonce in a new block. */
  useNonce(): void {
    this.block += 1n;
    this.lane.push({ block: this.block, nonce: this.nonce + 1 });
  }

  get ownNonce(): number {
    return this.own[this.own.length - 1]?.nonce ?? 0;
  }

  /** The root sends something of its own in a new block. */
  useOwnNonce(): void {
    this.block += 1n;
    this.own.push({ block: this.block, nonce: this.ownNonce + 1 });
  }

  revoke(): void {
    this.key = { ...this.key, keyId: ZERO, expiry: 0n, isRevoked: true, remaining: 0n, periodEnd: 0n, scopes: [] };
  }

  forget(): void {
    this.key = { ...this.key, keyId: ZERO, expiry: 0n, enforceLimits: false, remaining: 0n, periodEnd: 0n, scopes: [] };
  }

  private guard(method: keyof TempoChain): void {
    if (this.failing.has(method)) throw new Error(`${method} failed: fetch failed`);
  }

  async assertChain(): Promise<void> {
    this.guard('assertChain');
    if (this.wrongChain) throw new Error('the RPC serves chain 4217, but moderato is chain 42431');
  }

  async head(): Promise<ChainHead> {
    this.guard('head');
    this.time += this.tick;
    this.block += 1n;
    return { number: this.block, timestamp: this.time, baseFeePerGas: this.baseFee };
  }

  async keyState(root: Address): Promise<RawKeyState> {
    this.guard('keyState');
    if (!isAddressEqual(root, this.account)) return { keyId: ZERO, expiry: 0n, enforceLimits: false, isRevoked: false, remaining: 0n, periodEnd: 0n, isScoped: true, scopes: [] };
    const expired = this.key.expiry <= BigInt(this.time);
    return expired ? { ...this.key, remaining: 0n, periodEnd: 0n } : this.key;
  }

  async balanceOf(_token: Address, owner: Address): Promise<bigint> {
    this.guard('balanceOf');
    if (isAddressEqual(owner, this.account)) return this.rootBalance;
    return isAddressEqual(owner, this.sponsor) ? this.sponsorBalance : 0n;
  }

  async laneNonce(_root: Address, atBlock?: bigint): Promise<number> {
    this.guard('laneNonce');
    this.nonceReads.push(atBlock ?? null);
    if (atBlock === undefined) return this.nonce;
    if (atBlock > this.block) throw nodeError(`block not found: 0x${atBlock.toString(16)}`, -32001);
    return [...this.lane].reverse().find((entry) => entry.block <= atBlock)?.nonce ?? 0;
  }

  async accountNonce(_root: Address, atBlock?: bigint): Promise<number> {
    this.guard('accountNonce');
    if (atBlock === undefined) return this.ownNonce;
    if (atBlock > this.block) throw nodeError(`block not found: 0x${atBlock.toString(16)}`, -32001);
    return [...this.own].reverse().find((entry) => entry.block <= atBlock)?.nonce ?? 0;
  }

  async memoLogs(query: { root: Address; memos: Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<ChainLog[]> {
    this.guard('memoLogs');
    this.searches.push({ fromBlock: query.fromBlock, toBlock: query.toBlock });
    return this.logs.filter(
      (log) =>
        log.topics[0] === TRANSFER_WITH_MEMO_TOPIC &&
        log.topics[1] === pad(query.root).toLowerCase() &&
        query.memos.includes(log.topics[3] ?? '0x') &&
        log.blockNumber >= query.fromBlock &&
        log.blockNumber <= query.toBlock,
    );
  }

  async receipt(hash: Hex): Promise<ChainReceipt | null> {
    this.guard('receipt');
    return this.receipts.get(hash) ?? null;
  }

  /** What the keychain would answer for these calls; null when it lets them through. */
  private violation(tx: PayoutTx): Hex | null {
    const calls = tx.calls.map((call) => decodeCall(call.data));
    const rules = this.key.scopes.flatMap((scope) => (isAddressEqual(scope.target, TOKEN) ? scope.selectorRules : []));
    const memoRule = rules.find((rule) => rule.selector === TRANSFER_WITH_MEMO_SELECTOR);
    for (const call of calls) {
      if (!this.key.isScoped) continue;
      if (call.kind !== 'memo' || !memoRule) return CALL_NOT_ALLOWED;
      if (memoRule.recipients.length > 0 && !memoRule.recipients.some((allowed) => isAddressEqual(allowed, call.to))) return CALL_NOT_ALLOWED;
    }
    const total = calls.reduce((sum, call) => (call.kind === 'other' ? sum : sum + call.amount), 0n);
    return this.key.enforceLimits && total > this.key.remaining ? SPENDING_LIMIT_EXCEEDED : null;
  }

  private keyRejection(): string | null {
    if (this.key.isRevoked) return 'keychain validation failed: AccountKeychainError(KeyAlreadyRevoked(KeyAlreadyRevoked))';
    if (this.key.expiry <= BigInt(this.time)) return 'keychain validation failed: AccountKeychainError(KeyExpired(KeyExpired))';
    return null;
  }

  private build(tx: PayoutTx): SignedTx {
    const serialized = toHex(`tx-${this.signed.length}-${tx.nonce}-${tx.validBefore}`);
    const hash = keccak256(serialized);
    this.signed.push(tx);
    this.built.set(serialized, { tx, hash });
    return { serialized, hash };
  }

  async signPayout(tx: PayoutTx): Promise<SignedTx> {
    this.guard('signPayout');
    // A key that arrives with its authorization is checked against that authorization.
    if (tx.keyAuthorization) return this.build(tx);
    const rejection = this.keyRejection();
    if (rejection) throw nodeError(`Revm error: ${rejection}`, -32603);
    const violation = this.violation(tx);
    if (violation) throw nodeError('execution reverted: Account keychain error', 3, violation);
    return this.build(tx);
  }

  async signForced(tx: ForcedTx): Promise<SignedTx> {
    this.guard('signForced');
    return this.build(tx);
  }

  async signRevocation(tx: RevocationTx): Promise<SignedTx> {
    this.guard('signRevocation');
    const serialized = toHex(`revocation-${this.revocations.length}-${tx.nonce}-${tx.validBefore}`);
    const hash = keccak256(serialized);
    this.revocations.push(tx);
    this.builtRevocations.set(serialized, { tx, hash });
    return { serialized, hash };
  }

  /** The keychain takes a key back from the account that holds it, and reverts for any other. */
  private mineRevocation(hash: Hex, tx: RevocationTx): void {
    this.useOwnNonce();
    const held = isAddressEqual(tx.root, this.account) && isAddressEqual(this.key.keyId, tx.accessKey) && !this.key.isRevoked;
    let logs: ChainLog[] = [];
    if (held) {
      this.revoke();
      const topics = [KEY_REVOKED_TOPIC, pad(tx.root).toLowerCase() as Hex, pad(tx.accessKey).toLowerCase() as Hex];
      logs = [{ address: Addresses.accountKeychain, topics, data: '0x', transactionHash: hash, blockNumber: this.block, logIndex: this.logIndex++ }];
    } else {
      this.reverts.set(hash, KEY_NOT_FOUND);
    }
    if (this.tamper) {
      logs = this.tamper(logs);
      this.tamper = null;
    }
    this.logs.push(...logs);
    this.receipts.set(hash, { status: held ? 'success' : 'reverted', blockNumber: this.block, gasUsed: 285_944n, logs });
  }

  private broadcastRevocation(built: { tx: RevocationTx; hash: Hex }): BroadcastResult {
    this.broadcasts.push(built.hash);
    if (this.onBroadcast === 'unreachable') throw new Error('fetch failed');
    if (built.tx.nonce !== this.ownNonce) return { accepted: false, reason: `nonce too low: next nonce ${this.ownNonce}, tx nonce ${built.tx.nonce}` };
    if (this.onBroadcast === 'drop') return { accepted: true };
    if (built.tx.validBefore > this.time) this.mineRevocation(built.hash, built.tx);
    if (this.onBroadcast === 'lost') throw new Error('fetch failed');
    return { accepted: true };
  }

  /** Stores the key a transaction carries and returns the event the keychain emits for it. */
  private provision(tx: PayoutTx, hash: Hex): ChainLog[] {
    if (!tx.keyAuthorization) return [];
    const granted = readSignedAuthorization(KeyAuthorization.serialize(tx.keyAuthorization));
    this.key = {
      keyId: granted.accessKey,
      expiry: BigInt(granted.expiry ?? 0),
      enforceLimits: granted.limits !== null,
      isRevoked: false,
      remaining: granted.limits?.[0]?.limit ?? 0n,
      periodEnd: BigInt(this.time + (granted.limits?.[0]?.period ?? 0)),
      isScoped: granted.isScoped,
      scopes: granted.scopes,
    };
    const topics = [KEY_AUTHORIZED_TOPIC, pad(tx.root).toLowerCase() as Hex, pad(granted.accessKey).toLowerCase() as Hex];
    return [{ address: Addresses.accountKeychain, topics, data: '0x', transactionHash: hash, blockNumber: this.block, logIndex: this.logIndex++ }];
  }

  private mine(hash: Hex, tx: PayoutTx): void {
    this.useNonce();
    // The key is stored even when the calls that travel with its authorization fail.
    let logs = this.provision(tx, hash);
    const violation = this.violation(tx);
    if (!violation) {
      for (const call of tx.calls.map((entry) => decodeCall(entry.data))) {
        if (call.kind === 'other') continue;
        const from = pad(tx.root).toLowerCase() as Hex;
        const to = pad(call.to).toLowerCase() as Hex;
        const data = toHex(call.amount, { size: 32 });
        const base = { address: TOKEN, data, transactionHash: hash, blockNumber: this.block };
        logs.push({ ...base, topics: [TRANSFER_TOPIC, from, to], logIndex: this.logIndex++ });
        if (call.kind === 'memo') logs.push({ ...base, topics: [TRANSFER_WITH_MEMO_TOPIC, from, to, call.memo], logIndex: this.logIndex++ });
        this.key = { ...this.key, remaining: this.key.remaining - call.amount };
        this.rootBalance -= call.amount;
      }
    } else {
      this.reverts.set(hash, violation);
    }
    if (this.tamper) {
      logs = this.tamper(logs);
      this.tamper = null;
    }
    this.logs.push(...logs);
    this.receipts.set(hash, { status: violation ? 'reverted' : 'success', blockNumber: this.block, gasUsed: 50_000n + 20_000n * BigInt(tx.calls.length), logs });
  }

  async broadcast(serialized: Hex): Promise<BroadcastResult> {
    this.guard('broadcast');
    const revocation = this.builtRevocations.get(serialized);
    if (revocation) return this.broadcastRevocation(revocation);
    const built = this.built.get(serialized);
    if (!built) throw new Error('unknown transaction bytes');
    this.broadcasts.push(built.hash);
    if (this.onBroadcast === 'unreachable') throw new Error('fetch failed');
    const rejection = built.tx.keyAuthorization ? null : this.keyRejection();
    if (rejection) return { accepted: false, reason: rejection };
    if (built.tx.nonce !== this.nonce) return { accepted: false, reason: `nonce too low: next nonce ${this.nonce}, tx nonce ${built.tx.nonce}` };
    if (this.onBroadcast === 'drop') return { accepted: true };
    if (built.tx.validBefore > this.time) this.mine(built.hash, built.tx);
    if (this.onBroadcast === 'lost') throw new Error('fetch failed');
    return { accepted: true };
  }

  async revertData(hash: Hex): Promise<Hex | null> {
    this.guard('revertData');
    return this.servesTraces ? (this.reverts.get(hash) ?? null) : null;
  }
}

export function setup(overrides: Partial<TempoRailConfig> = {}) {
  const accessKey = generateAccessKey();
  const sponsorPrivateKey = generatePrivateKey();
  const chain = new FakeChain(accessKey.address, privateKeyToAddress(sponsorPrivateKey));
  let now = 0;
  const rail = createTempoPayoutRail(
    { network: 'moderato', token: TOKEN, accessKeyPrivateKey: accessKey.privateKey, sponsorPrivateKey, ...overrides },
    { chain, sleep: async () => undefined, clock: () => (now += 1_000) },
  );
  return { rail, chain, accessKey, sponsorPrivateKey };
}

export function line(runId: string, n: number, to: Address, amount: bigint) {
  return { to, amount, memo: `${runId}/${n}` };
}

/** The terms a treasurer is asked to sign in these tests, and the authorization the root of `ROOT` signs for them. */
export function policyFor(accessKeyAddress: Address, over: Partial<AccessKeyPolicyInput> = {}): AccessKeyPolicyInput {
  return { rootAddress: ROOT, accessKeyAddress, token: TOKEN, limit: 10_000_000n, periodSeconds: 3_600, expiry: START + 86_400, recipients: PAYEES, chainId: 42431, ...over };
}

export async function signAuthorization(expected: AccessKeyPolicyInput, signer: { sign: (i: { hash: Hex }) => Promise<Hex> } = ROOT_ACCOUNT): Promise<Hex> {
  const request = buildAccessKeyAuthorization(expected);
  return serializeSignedAuthorization(request.authorization, await signer.sign({ hash: request.signPayload }));
}

/**
 * A revocation signed the way a wallet signs one with the SDK: one
 * `revokeKey` call, for a fee payer to pay for. `over` changes what is signed,
 * for transactions that are something other than what was prepared.
 */
export async function signRevocation(request: RevocationRequest, signer: Pick<typeof ROOT_ACCOUNT, 'signTransaction'> = ROOT_ACCOUNT, over: Record<string, unknown> = {}): Promise<Hex> {
  const transaction = {
    type: 'tempo',
    chainId: request.chainId,
    calls: [buildRevoke({ accessKeyAddress: request.accessKey })],
    nonce: request.nonce,
    nonceKey: request.nonceKey,
    gas: request.gas,
    maxFeePerGas: request.maxFeePerGas,
    maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    validBefore: request.validBefore,
    feePayer: true,
    ...over,
  };
  return signer.signTransaction(transaction as Parameters<typeof ROOT_ACCOUNT.signTransaction>[0]);
}
