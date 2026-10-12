import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { type Api, type SolanaRail, api as defaultApi } from './api';
import { ClientError, walletError } from './errors';

/**
 * The treasurer's Solana wallet. It owns the token account payouts are made
 * from and approves the service key as delegate for a fixed amount. The
 * server prepares the approval and the revocation as unsigned transactions;
 * the wallet signs and sends them itself. Whether either took effect is read
 * from the server, which reads it from the chain.
 */

// Bytes and their encodings.

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 as Solana writes addresses and signatures. */
export function base58Encode(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += (digits[i] ?? 0) << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    for (; carry > 0; carry = Math.floor(carry / 58)) digits.push(carry % 58);
  }
  let text = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) text += BASE58[0];
  for (let i = digits.length - 1; i >= 0; i -= 1) text += BASE58[digits[i] ?? 0];
  return text;
}

/** The bytes a base58 text stands for. Throws a RangeError for a text that is not base58. */
export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    let carry = BASE58.indexOf(character);
    if (carry < 0) throw new RangeError(`"${character}" is not a base58 character`);
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] ?? 0) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    for (; carry > 0; carry >>= 8) bytes.push(carry & 0xff);
  }
  for (let i = 0; i < text.length && text[i] === BASE58[0]; i += 1) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

function base64Decode(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text);
  } catch (error) {
    throw new ClientError('unexpected_request', 'the transaction the server prepared is not base64', { cause: error });
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// The token account of a wallet.

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const KEY_BYTES = 32;

/** The prime of the field ed25519 is over, and the curve's constant d. */
const P = 2n ** 255n - 19n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

const mod = (value: bigint): bigint => ((value % P) + P) % P;

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = mod(base);
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) result = (result * square) % P;
    square = (square * square) % P;
  }
  return result;
}

/**
 * Whether thirty-two bytes are a point of the ed25519 curve: whether there
 * is an x for the y they hold. Solana gives a program's own accounts the
 * addresses that are not.
 */
function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = KEY_BYTES - 1; i >= 0; i -= 1) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  // The top bit is the sign of x and no part of y.
  y = mod(y & ((1n << 255n) - 1n));
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  // u v^3 (u v^7)^((p - 5) / 8) is a square root of u / v when u / v has one.
  const v3 = mod(v * v * v);
  const x = mod(u * v3 * power(u * v3 * v3 * v, (P - 5n) / 8n));
  const square = mod(v * x * x);
  return square === u || square === mod(-u);
}

function key(address: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(address);
  } catch (error) {
    throw new ClientError('invalid_argument', `${what} "${address}" is not a Solana address`, { cause: error });
  }
  if (bytes.length !== KEY_BYTES) throw new ClientError('invalid_argument', `${what} "${address}" is not a Solana address`);
  return bytes;
}

/**
 * The associated token account of a wallet for a mint under the Token
 * program: the account the server's transactions are built for. Its address
 * is derived, not looked up, so it can be told here whether a transaction
 * touches that account or some other.
 */
export async function associatedTokenAddress(owner: string, mint: string): Promise<string> {
  const seeds = [...key(owner, 'the wallet'), ...key(TOKEN_PROGRAM, 'the program'), ...key(mint, 'the mint')];
  const program = [...key(ASSOCIATED_TOKEN_PROGRAM, 'the program'), ...new TextEncoder().encode('ProgramDerivedAddress')];
  // The first of these that is no point of the curve is the address; about every second one is none.
  for (let bump = 255; bump >= 0; bump -= 1) {
    const address = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...seeds, bump, ...program])));
    if (!onCurve(address)) return base58Encode(address);
  }
  throw new ClientError('invalid_argument', 'there is no token account address for this wallet and mint');
}

// A transaction as the wire carries it.

const APPROVE_CHECKED = 13;
const REVOKE = 5;
const SIGNATURE_BYTES = 64;

export interface SolanaInstruction {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

export interface SolanaTransaction {
  version: 'legacy' | 0;
  /** The accounts that have to sign, the fee payer first. */
  signers: string[];
  /** Whether each signature slot is still empty. */
  unsigned: boolean;
  signatures: Uint8Array[];
  instructions: SolanaInstruction[];
  /** The bytes that are signed. */
  message: Uint8Array;
}

class Reader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.at;
  }

  get done(): boolean {
    return this.at === this.bytes.length;
  }

  byte(): number {
    const value = this.bytes[this.at];
    if (value === undefined) throw new RangeError('the transaction ends early');
    this.at += 1;
    return value;
  }

  take(length: number): Uint8Array {
    if (this.at + length > this.bytes.length) throw new RangeError('the transaction ends early');
    const slice = this.bytes.slice(this.at, this.at + length);
    this.at += length;
    return slice;
  }

  /**
   * A length as Solana writes it: sixteen bits, seven to a byte, lowest
   * first, in as few bytes as hold it. Any other writing of the same number
   * is refused, as Solana itself refuses it.
   */
  length(): number {
    let value = 0;
    for (let index = 0; index < 3; index += 1) {
      const byte = this.byte();
      const last = (byte & 0x80) === 0;
      if ((index === 2 && byte > 0x03) || (last && index > 0 && byte === 0)) break;
      value |= (byte & 0x7f) << (7 * index);
      if (last) return value;
    }
    throw new RangeError('a length in the transaction is malformed');
  }
}

/**
 * Read a wire transaction far enough to say who signs it and what it does.
 * One that loads accounts from an address lookup table is refused: what it
 * touches could not be told from its bytes.
 */
export function readSolanaTransaction(wire: Uint8Array): SolanaTransaction {
  const reader = new Reader(wire);
  const signatures = Array.from({ length: reader.length() }, () => reader.take(SIGNATURE_BYTES));
  const messageStart = reader.offset;

  let version: SolanaTransaction['version'] = 'legacy';
  let required = reader.byte();
  if ((required & 0x80) !== 0) {
    if ((required & 0x7f) !== 0) throw new RangeError(`transaction version ${required & 0x7f} is not known`);
    version = 0;
    required = reader.byte();
  }
  reader.byte();
  reader.byte();
  const keys = Array.from({ length: reader.length() }, () => base58Encode(reader.take(KEY_BYTES)));
  reader.take(KEY_BYTES);

  const account = (index: number): string => {
    const named = keys[index];
    if (named === undefined) throw new RangeError('the transaction names an account it does not list');
    return named;
  };
  const instructions = Array.from({ length: reader.length() }, (): SolanaInstruction => {
    const program = account(reader.byte());
    const accounts = Array.from({ length: reader.length() }, () => account(reader.byte()));
    return { program, accounts, data: reader.take(reader.length()) };
  });
  if (version === 0 && reader.length() !== 0) throw new RangeError('the transaction loads accounts from a lookup table');
  if (!reader.done) throw new RangeError('the transaction has bytes after its end');
  if (required !== signatures.length || required > keys.length) throw new RangeError('the transaction does not have one signature slot for each signer');

  return {
    version,
    signers: keys.slice(0, required),
    unsigned: signatures.every((signature) => signature.every((byte) => byte === 0)),
    signatures,
    instructions,
    message: wire.slice(messageStart),
  };
}

function u64(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i] ?? 0);
  return value;
}

export type ExpectedTransaction =
  | { kind: 'approval'; owner: string; tokenAccount: string; mint: string; delegate: string; amount: bigint; decimals: number }
  | { kind: 'revoke'; owner: string; tokenAccount: string };

/**
 * Hold a transaction the server prepared to what was asked of it: unsigned,
 * signed and paid for by the owner alone, and made of the one Token program
 * instruction that approves this delegate for this amount of this mint on
 * this token account, or that revokes the delegation on it. Anything else is
 * refused before the wallet sees it.
 */
export function checkOwnerTransaction(wire: Uint8Array, expected: ExpectedTransaction): SolanaTransaction {
  const refuse = (why: string) => new ClientError('unexpected_request', `the transaction the server prepared ${why}; nothing was signed`);
  let transaction: SolanaTransaction;
  try {
    transaction = readSolanaTransaction(wire);
  } catch (error) {
    throw new ClientError('unexpected_request', `the transaction the server prepared cannot be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!transaction.unsigned) throw refuse('already carries a signature');
  if (transaction.signers.length !== 1 || transaction.signers[0] !== expected.owner) throw refuse('is not signed and paid for by the wallet of the organisation alone');
  const [instruction, ...others] = transaction.instructions;
  if (instruction === undefined || others.length > 0) throw refuse('does not consist of one instruction');
  if (instruction.program !== TOKEN_PROGRAM) throw refuse('calls another program than the Token program');

  const { accounts, data } = instruction;
  if (expected.kind === 'approval') {
    const [source, mint, delegate, owner] = accounts;
    if (accounts.length !== 4 || data.length !== 10 || data[0] !== APPROVE_CHECKED) throw refuse('is not an approval of a delegate');
    if (owner !== expected.owner || mint !== expected.mint || delegate !== expected.delegate) throw refuse('approves another delegate, or does so for another token or account');
    if (source !== expected.tokenAccount) throw refuse('approves the delegate on another token account than the wallet’s own for this token');
    if (u64(data.slice(1, 9)) !== expected.amount || data[9] !== expected.decimals) throw refuse('approves another amount than the one asked for');
  } else {
    const [source, owner] = accounts;
    if (accounts.length !== 2 || data.length !== 1 || data[0] !== REVOKE) throw refuse('is not the revocation of a delegate');
    if (owner !== expected.owner) throw refuse('revokes for another account');
    if (source !== expected.tokenAccount) throw refuse('revokes the delegation on another token account than the wallet’s own for this token');
  }
  return transaction;
}

// Wallets.

/** A cluster as Wallet Standard names it. */
export type SolanaChain = 'solana:mainnet' | 'solana:devnet';

export function solanaChainOf(cluster: string): SolanaChain {
  if (cluster === 'mainnet-beta') return 'solana:mainnet';
  if (cluster === 'devnet') return 'solana:devnet';
  throw new ClientError('invalid_argument', `there is no wallet chain for the Solana cluster "${cluster}"`);
}

/** Where a transaction can be looked at; the same link the server gives for its own. */
export function solanaTxUrl(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const EVENTS = 'standard:events';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: 'change', listener: (properties: { accounts?: readonly WalletAccount[] }) => void): () => void;
}
interface SignAndSendFeature {
  supportedTransactionVersions: readonly ('legacy' | 0 | 1)[];
  signAndSendTransaction(...inputs: readonly { account: WalletAccount; transaction: Uint8Array; chain: `${string}:${string}` }[]): Promise<readonly { signature: Uint8Array }[]>;
}

/** The provider Phantom and wallets like it left on `window` before Wallet Standard. */
interface InjectedProvider {
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>;
  disconnect(): Promise<void>;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (payload: unknown) => void): unknown;
  off?(event: string, listener: (payload: unknown) => void): unknown;
  removeListener?(event: string, listener: (payload: unknown) => void): unknown;
}

export interface SolanaWallet {
  /** Stable while the page lives. */
  id: string;
  name: string;
  /** A data URI the wallet supplied for itself; null when it gave none. Draw it as the source of an image, never as markup. */
  icon: string | null;
  /** How the wallet was found: registered through Wallet Standard, or left on `window` by an older wallet. */
  source: 'standard' | 'injected';
  /** The chains the wallet says it works on, such as `solana:mainnet`; empty for an injected provider, which does not say. */
  chains: readonly string[];
  /** The wallet itself, for the functions of this module. */
  handle: Wallet | InjectedProvider;
}

function feature<T>(wallet: Wallet, name: string): T | undefined {
  return (wallet.features as Record<string, unknown>)[name] as T | undefined;
}

function usable(wallet: Wallet): boolean {
  return wallet.chains.some((chain) => chain.startsWith('solana:')) && feature(wallet, CONNECT) !== undefined && feature(wallet, SIGN_AND_SEND) !== undefined;
}

function injectedWallet(): SolanaWallet | null {
  const scope = window as { phantom?: { solana?: Partial<InjectedProvider> }; solana?: Partial<InjectedProvider> };
  const provider = scope.phantom?.solana ?? scope.solana;
  if (provider === undefined || provider === null || typeof provider.connect !== 'function' || typeof provider.request !== 'function') return null;
  return { id: 'injected', name: 'Browser wallet', icon: null, source: 'injected', chains: [], handle: provider as InjectedProvider };
}

/**
 * Keep `listener` told of the Solana wallets this browser has that can sign
 * and send a transaction. Wallets register through Wallet Standard at any
 * time, so it is called at once and again on every change; a provider left on
 * `window` is listed only while none has registered. Returns the function
 * that stops the watch.
 */
export function watchSolanaWallets(listener: (wallets: SolanaWallet[]) => void): () => void {
  const registry = getWallets();
  const tell = () => {
    const standard = registry
      .get()
      .filter(usable)
      .map((wallet): SolanaWallet => ({ id: `standard:${wallet.name}`, name: wallet.name, icon: wallet.icon, source: 'standard', chains: wallet.chains, handle: wallet }));
    const fallback = standard.length === 0 && typeof window !== 'undefined' ? injectedWallet() : null;
    listener(fallback === null ? standard : [fallback]);
  };
  const stops = [registry.on('register', tell), registry.on('unregister', tell)];
  tell();
  return () => stops.forEach((stop) => stop());
}

export interface SolanaConnection {
  readonly wallet: SolanaWallet;
  /** The account the wallet shares, in base58; null once it has withdrawn it. */
  address(): string | null;
  /** Called with the new address whenever the wallet changes account. Returns the function that stops it. */
  subscribe(listener: (address: string | null) => void): () => void;
  /**
   * Have the wallet sign a transaction and send it through its own
   * connection to the cluster. The transaction has to be one that the account
   * the wallet shares at that moment signs, and signs alone. Resolves with the
   * transaction's signature in base58, which says it was sent, not that it
   * landed.
   */
  signAndSend(wire: Uint8Array, chain: SolanaChain): Promise<string>;
  /** Stop following the wallet. Nothing is asked of the wallet, which stays connected to the site. */
  close(): void;
  /** Stop following the wallet and have it disconnect from the site. */
  disconnect(): Promise<void>;
}

function signs(account: WalletAccount): boolean {
  return account.features.includes(SIGN_AND_SEND) && account.chains.some((chain) => chain.startsWith('solana:'));
}

/**
 * A transaction about to be handed to a wallet, read here first. Bytes that
 * are no transaction never reach the wallet, and neither does a transaction
 * that anyone but the account at hand has to sign.
 */
function signable(wire: Uint8Array, signer: string): SolanaTransaction {
  let transaction: SolanaTransaction;
  try {
    transaction = readSolanaTransaction(wire);
  } catch (error) {
    throw new ClientError('invalid_argument', `these bytes are not a transaction: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (transaction.signers.length !== 1 || transaction.signers[0] !== signer) {
    throw new ClientError('wrong_account', `the wallet shares ${signer}, and the transaction is for ${transaction.signers.join(' and ')} to sign; nothing was signed`);
  }
  return transaction;
}

function connectStandard(wallet: SolanaWallet, handle: Wallet, accounts: readonly WalletAccount[], preferred: string | undefined): SolanaConnection | null {
  const pick = (from: readonly WalletAccount[], address: string | undefined) => from.filter(signs).find((account) => address === undefined || account.address === address);
  let account = pick(accounts, preferred) ?? pick(accounts, undefined);
  if (account === undefined) return null;

  const listeners = new Set<(address: string | null) => void>();
  const stop = feature<EventsFeature>(handle, EVENTS)?.on('change', (properties) => {
    if (properties.accounts === undefined) return;
    // The wallet keeps the account it had if it still shares it, and moves to the first it shares otherwise.
    const next = pick(properties.accounts, account?.address) ?? pick(properties.accounts, undefined);
    if (next?.address === account?.address) {
      account = next;
      return;
    }
    account = next;
    for (const listener of [...listeners]) listener(account?.address ?? null);
  });
  const close = (): void => {
    stop?.();
    const had = account !== undefined;
    account = undefined;
    if (had) for (const listener of [...listeners]) listener(null);
    listeners.clear();
  };

  return {
    wallet,
    address: () => account?.address ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async signAndSend(wire, chain) {
      const signer = account;
      const sender = feature<SignAndSendFeature>(handle, SIGN_AND_SEND);
      if (signer === undefined || sender === undefined) throw new ClientError('wallet_unavailable', `${wallet.name} shares no account that can sign`);
      if (!signer.chains.includes(chain)) throw new ClientError('wallet_unavailable', `the account in ${wallet.name} is not on ${chain}`);
      const { version } = signable(wire, signer.address);
      if (!sender.supportedTransactionVersions.includes(version)) throw new ClientError('wallet_unavailable', `${wallet.name} does not sign version ${version} transactions`);
      let outputs: readonly { signature: Uint8Array }[];
      try {
        outputs = await sender.signAndSendTransaction({ account: signer, transaction: wire, chain });
      } catch (error) {
        throw walletError(error, 'signing the transaction');
      }
      const signature = outputs[0]?.signature;
      if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) throw new ClientError('wallet_failed', `${wallet.name} did not answer with the signature of the transaction`);
      return base58Encode(signature);
    },
    close,
    async disconnect() {
      close();
      try {
        await feature<DisconnectFeature>(handle, DISCONNECT)?.disconnect();
      } catch {
        // The wallet would not disconnect; this side has let go of it all the same.
      }
    },
  };
}

function connectInjected(wallet: SolanaWallet, provider: InjectedProvider, first: string): SolanaConnection {
  let address: string | null = first;
  const listeners = new Set<(address: string | null) => void>();
  const change = (next: string | null) => {
    if (next === address) return;
    address = next;
    for (const listener of [...listeners]) listener(address);
  };
  const onAccount = (publicKey: unknown) => change(publicKey === null || publicKey === undefined ? null : String(publicKey));
  const onDisconnect = () => change(null);
  provider.on?.('accountChanged', onAccount);
  provider.on?.('disconnect', onDisconnect);
  const close = (): void => {
    const remove = provider.off ?? provider.removeListener;
    remove?.call(provider, 'accountChanged', onAccount);
    remove?.call(provider, 'disconnect', onDisconnect);
    change(null);
    listeners.clear();
  };

  return {
    wallet,
    address: () => address,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /**
     * An injected provider is not told a chain: it sends on the cluster the
     * wallet itself is set to. It takes the message to sign in base58, the
     * way Phantom documents its `signAndSendTransaction` request.
     */
    async signAndSend(wire) {
      if (address === null) throw new ClientError('wallet_unavailable', `${wallet.name} shares no account`);
      const { message } = signable(wire, address);
      let answer: unknown;
      try {
        answer = await provider.request({ method: 'signAndSendTransaction', params: { message: base58Encode(message) } });
      } catch (error) {
        throw walletError(error, 'signing the transaction');
      }
      const signature = (answer as { signature?: unknown } | null)?.signature;
      if (typeof signature !== 'string' || signature === '') throw new ClientError('wallet_failed', `${wallet.name} did not answer with the signature of the transaction`);
      return signature;
    },
    close,
    async disconnect() {
      close();
      try {
        await provider.disconnect();
      } catch {
        // The wallet would not disconnect; this side has let go of it all the same.
      }
    },
  };
}

export interface SolanaConnectOptions {
  /** Ask only for what the site may already see and open nothing; resolves to null when that is nothing. */
  silent?: boolean;
  /** The account wanted, when the wallet shares several: the organisation's `solanaOwner`. */
  address?: string;
}

/** Connect to a wallet and take the account it shares. */
export async function connectSolanaWallet(wallet: SolanaWallet, options?: SolanaConnectOptions & { silent?: false }): Promise<SolanaConnection>;
export async function connectSolanaWallet(wallet: SolanaWallet, options: SolanaConnectOptions & { silent: true }): Promise<SolanaConnection | null>;
export async function connectSolanaWallet(wallet: SolanaWallet, options: SolanaConnectOptions = {}): Promise<SolanaConnection | null> {
  const silent = options.silent === true;
  let connection: SolanaConnection | null;
  try {
    if (wallet.source === 'standard') {
      const handle = wallet.handle as Wallet;
      const connector = feature<ConnectFeature>(handle, CONNECT);
      if (connector === undefined) throw new ClientError('wallet_unavailable', `${wallet.name} cannot be connected to`);
      const { accounts } = await connector.connect(silent ? { silent: true } : undefined);
      connection = connectStandard(wallet, handle, accounts, options.address);
    } else {
      const provider = wallet.handle as InjectedProvider;
      const { publicKey } = await provider.connect(silent ? { onlyIfTrusted: true } : undefined);
      connection = connectInjected(wallet, provider, publicKey.toString());
    }
  } catch (error) {
    // A wallet that does not know the site yet answers a silent request with a refusal.
    if (silent) return null;
    throw walletError(error, 'connecting');
  }
  if (connection === null && !silent) throw new ClientError('wallet_unavailable', `${wallet.name} shared no account that can sign and send a Solana transaction`);
  return connection;
}

// The approval and its revocation.

export interface SolanaSubmission {
  /** The signature of the transaction the wallet sent, in base58. */
  signature: string;
  /** Where the transaction can be looked at. */
  txUrl: string;
  /** The wallet has until this block height to get the transaction on chain. */
  lastValidBlockHeight: string;
}

export interface SolanaFlowOptions {
  api?: Api;
}

interface Standing {
  rail: SolanaRail;
  /** The organisation's wallet, which the connected wallet shares. */
  owner: string;
  /** The wallet's own token account for the rail's token. */
  tokenAccount: string;
  /** The organisation's service key; null when it has none. */
  delegate: string | null;
}

/**
 * The rail of the organisation, held against the organisation's own profile,
 * once it is settled that the wallet shares the account that owns its token
 * account. The token account is worked out here, not taken from the server.
 */
async function standing(api: Api, orgId: string, connection: SolanaConnection): Promise<Standing> {
  const [org, rail] = await Promise.all([api.getOrg(orgId), api.solanaRail(orgId)]);
  if (org.solanaOwner === null || rail.owner === null) throw new ClientError('wrong_account', 'the organisation has no Solana wallet yet; set one in its profile first');
  const key = org.serviceKeys.find((candidate) => candidate.kind === 'solana_delegate');
  if (rail.owner !== org.solanaOwner || (rail.delegate ?? null) !== (key?.address ?? null)) {
    throw new ClientError('unexpected_request', 'the rail names another wallet or another service key than the organisation’s own; nothing was signed');
  }
  const address = connection.address();
  if (address !== rail.owner) {
    throw new ClientError('wrong_account', `the wallet shares ${address ?? 'no account'}, and the transaction has to be signed by ${rail.owner}, the wallet of the organisation`);
  }
  return { rail, owner: rail.owner, tokenAccount: await associatedTokenAddress(rail.owner, rail.token.address), delegate: rail.delegate };
}

/**
 * Approve the service key as delegate of the organisation's token account
 * for `amount` base units. An approval replaces the one before it: the
 * allowance becomes `amount`, it is not added to what is left.
 *
 * Resolves once the wallet has sent the transaction. Whether it took effect
 * is for `waitForSolanaAllowance` to say.
 */
export async function approveSolanaDelegate(connection: SolanaConnection, orgId: string, amount: bigint, options: SolanaFlowOptions = {}): Promise<SolanaSubmission> {
  const api = options.api ?? defaultApi;
  if (amount <= 0n) throw new ClientError('invalid_argument', 'the amount to approve has to be more than nothing');
  const { rail, owner, tokenAccount, delegate } = await standing(api, orgId, connection);
  const prepared = await api.solanaApproval(orgId, amount);
  const wire = base64Decode(prepared.transaction);
  if (delegate === null) throw new ClientError('unexpected_request', 'the server prepared an approval for an organisation that has no service key; nothing was signed');
  checkOwnerTransaction(wire, { kind: 'approval', owner, tokenAccount, mint: rail.token.address, delegate, amount, decimals: rail.token.decimals });
  const signature = await connection.signAndSend(wire, solanaChainOf(rail.cluster));
  return { signature, txUrl: solanaTxUrl(signature, rail.cluster), lastValidBlockHeight: prepared.lastValidBlockHeight };
}

/** Take the delegation back. Resolves once the wallet has sent the transaction; `waitForSolanaAllowance(orgId, 0n)` says when it took effect. */
export async function revokeSolanaDelegate(connection: SolanaConnection, orgId: string, options: SolanaFlowOptions = {}): Promise<SolanaSubmission> {
  const api = options.api ?? defaultApi;
  const { rail, owner, tokenAccount } = await standing(api, orgId, connection);
  const prepared = await api.solanaRevoke(orgId);
  const wire = base64Decode(prepared.transaction);
  checkOwnerTransaction(wire, { kind: 'revoke', owner, tokenAccount });
  const signature = await connection.signAndSend(wire, solanaChainOf(rail.cluster));
  return { signature, txUrl: solanaTxUrl(signature, rail.cluster), lastValidBlockHeight: prepared.lastValidBlockHeight };
}

export interface WaitOptions extends SolanaFlowOptions {
  /** How many times the server is asked; 20 unless given. */
  attempts?: number;
  /** The pause between two askings, in ms; 3000 unless given. */
  intervalMs?: number;
  signal?: AbortSignal;
  /** Used in place of a timer. */
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the server reads from the chain that the delegate may move
 * exactly `expected` base units: the amount just approved, or zero after a
 * revocation. The wallet's word is not taken for it. Rejects with
 * `not_confirmed` when the chain does not show it in time, which does not
 * mean the transaction failed; its details hold the last reading.
 */
export async function waitForSolanaAllowance(orgId: string, expected: bigint, options: WaitOptions = {}): Promise<SolanaRail> {
  const api = options.api ?? defaultApi;
  const attempts = options.attempts ?? 20;
  const sleep = options.sleep ?? pause;
  let last: SolanaRail | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(options.intervalMs ?? 3_000);
    if (options.signal?.aborted === true) throw new ClientError('aborted', 'the wait was given up');
    last = await api.solanaRail(orgId, options.signal === undefined ? {} : { signal: options.signal });
    if (last.allowance.status === 'ok' && BigInt(last.allowance.value.remaining) === expected) return last;
  }
  throw new ClientError('not_confirmed', `the chain does not show an allowance of ${expected} yet`, { details: { allowance: last?.allowance ?? null } });
}
