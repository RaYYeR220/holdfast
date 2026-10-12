import { webcrypto } from 'node:crypto';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { type Hex, hexToNumber, keccak256, numberToHex, toHex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import type { Eip1193Provider } from '../../../src/client/evm';
import { base58Encode } from '../../../src/client/solana';

/**
 * Stand-ins for what a browser and its wallets give a page: an EIP-1193
 * provider that signs with a key the test holds, a Wallet Standard wallet
 * that signs with a real Ed25519 key, a passkey authenticator in software,
 * and the few things of `window` the client reads.
 */

type Listener = (payload: unknown) => void;

/** An EVM wallet as a page sees it. It signs with the local accounts it was given and behaves the way MetaMask does where that matters. */
export class FakeEvmWallet implements Eip1193Provider {
  chainId: number;
  /** Whether the site may see the accounts; a wallet grants that on `eth_requestAccounts`. */
  authorized = false;
  /** Every request made of the wallet, in order. */
  readonly requests: { method: string; params: unknown }[] = [];
  /** When set, the next request that would open the wallet fails with this and it is cleared. */
  failNext: { code?: number; message: string } | null = null;
  /** The chains the wallet has been given; null for a wallet that moves to any chain it is asked for. */
  knownChains: Set<number> | null = null;
  /** Whether the wallet moves to a chain as it is given it. */
  switchesOnAdd = true;
  /** What the wallet was asked to send, with the chain it was on then. Nothing is sent anywhere. */
  readonly transactions: { chainId: number; from: string; to: string; data: Hex; hash: Hex }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private accounts: LocalAccount[],
    chainId = 42_161,
  ) {
    this.chainId = chainId;
  }

  on(event: string, listener: Listener): void {
    const set = this.listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(event, set);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  /** The treasurer picks other accounts in the wallet; none locks it. */
  selectAccounts(accounts: LocalAccount[]): void {
    this.accounts = accounts;
    this.emit('accountsChanged', this.authorized ? accounts.map((account) => account.address.toLowerCase()) : []);
  }

  /** The treasurer changes network in the wallet. */
  selectChain(chainId: number): void {
    this.chainId = chainId;
    this.emit('chainChanged', numberToHex(chainId));
  }

  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  private fail(): void {
    if (this.failNext === null) return;
    const { code, message } = this.failNext;
    this.failNext = null;
    throw Object.assign(new Error(message), code === undefined ? {} : { code });
  }

  private signer(address: unknown): LocalAccount {
    const account = this.accounts.find((candidate) => candidate.address.toLowerCase() === String(address).toLowerCase());
    if (account === undefined || !this.authorized) throw Object.assign(new Error('The requested account has not been authorized by the user.'), { code: 4100 });
    return account;
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.requests.push({ method, params });
    const list = (Array.isArray(params) ? params : []) as unknown[];
    switch (method) {
      case 'eth_requestAccounts':
        this.fail();
        this.authorized = true;
        return this.accounts.map((account) => account.address.toLowerCase());
      case 'eth_accounts':
        return this.authorized ? this.accounts.map((account) => account.address.toLowerCase()) : [];
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'personal_sign': {
        this.fail();
        return this.signer(list[1]).signMessage({ message: { raw: list[0] as Hex } });
      }
      case 'eth_signTypedData_v4': {
        this.fail();
        const account = this.signer(list[0]);
        const { domain, types, primaryType, message } = JSON.parse(String(list[1])) as { domain: { chainId?: number }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> };
        // A wallet signs typed data only for the chain it is on.
        if (domain.chainId !== undefined && Number(domain.chainId) !== this.chainId) {
          throw Object.assign(new Error(`Provided chainId "${domain.chainId}" must match the active chainId "${this.chainId}"`), { code: -32603 });
        }
        const { EIP712Domain: _, ...rest } = types;
        return account.signTypedData({ domain, types: rest, primaryType, message } as Parameters<LocalAccount['signTypedData']>[0]);
      }
      case 'wallet_switchEthereumChain': {
        this.fail();
        const wanted = hexToNumber((list[0] as { chainId: Hex }).chainId);
        if (this.knownChains !== null && !this.knownChains.has(wanted)) {
          throw Object.assign(new Error(`Unrecognized chain ID "${(list[0] as { chainId: Hex }).chainId}". Try adding the chain using wallet_addEthereumChain first.`), { code: 4902 });
        }
        this.selectChain(wanted);
        return null;
      }
      case 'wallet_addEthereumChain': {
        this.fail();
        const added = hexToNumber((list[0] as { chainId: Hex }).chainId);
        this.knownChains?.add(added);
        // MetaMask moves to a chain it has just been given; other wallets only add it.
        if (this.switchesOnAdd) this.selectChain(added);
        return null;
      }
      case 'eth_sendTransaction': {
        this.fail();
        const { from, to, data, chainId } = list[0] as { from: string; to: string; data: Hex; chainId?: Hex };
        this.signer(from);
        // A transaction that names a chain is sent on that chain or not at all.
        if (chainId !== undefined && hexToNumber(chainId) !== this.chainId) {
          throw Object.assign(new Error(`Invalid transaction params: chainId ${chainId} does not match the chain the wallet is on`), { code: -32602 });
        }
        const hash = keccak256(toHex(`${this.chainId}:${from}:${to}:${data}:${this.transactions.length}`));
        this.transactions.push({ chainId: this.chainId, from, to, data, hash });
        return hash;
      }
      case 'wallet_revokePermissions':
        this.authorized = false;
        return null;
      default:
        throw Object.assign(new Error(`The method ${method} does not exist`), { code: -32601 });
    }
  }
}

/** A `window` with what the client reads of one: events, the page's address and storage. */
export function fakeWindow(origin = 'https://app.holdfast.test'): EventTarget & { location: { origin: string; host: string; hostname: string }; localStorage: Storage; ethereum?: unknown; solana?: unknown; phantom?: unknown } {
  const url = new URL(origin);
  const values = new Map<string, string>();
  const localStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
  return Object.assign(new EventTarget(), { location: { origin: url.origin, host: url.host, hostname: url.hostname }, localStorage });
}

/** Announce a wallet the way EIP-6963 has a wallet do it: at once, and again whenever a page asks. */
export function announce(target: EventTarget, provider: Eip1193Provider, info: { uuid: string; name: string; rdns: string; icon?: string }): () => void {
  const detail = Object.freeze({ info: { icon: 'data:image/svg+xml;base64,PHN2Zy8+', ...info }, provider });
  const tell = () => target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  target.addEventListener('eip6963:requestProvider', tell);
  tell();
  return () => target.removeEventListener('eip6963:requestProvider', tell);
}

const { subtle } = webcrypto;

export interface FakeSolanaWallet {
  wallet: Wallet;
  /** The address of the wallet's first account. */
  address: string;
  /** What the wallet was asked to sign and send, as it sent it: the wire transaction with its signature in place. */
  sent: { wire: Uint8Array; chain: string; signature: Uint8Array }[];
  /** How often the wallet was opened to connect. */
  prompts: number;
  /** When set, the next signing fails with this and it is cleared. */
  failNext: { code?: number; message: string } | null;
  /** Whether `signature` is that of the wallet's first account over `message`. */
  verify(message: Uint8Array, signature: Uint8Array): Promise<boolean>;
  /** The treasurer switches to a fresh account in the wallet. Resolves with its address. */
  switchAccount(): Promise<string>;
}

/** A Solana wallet registered the Wallet Standard way, signing with real Ed25519 keys it makes for itself. */
export async function fakeSolanaWallet(options: { name?: string; chains?: readonly `solana:${string}`[]; versions?: readonly ('legacy' | 0)[]; features?: 'all' | 'sign-only' } = {}): Promise<FakeSolanaWallet> {
  const chains = options.chains ?? ['solana:mainnet', 'solana:devnet'];
  const listeners = new Set<(properties: { accounts?: readonly WalletAccount[] }) => void>();
  const makeAccount = async () => {
    const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    const account: WalletAccount = { address: base58Encode(publicKey), publicKey, chains, features: ['solana:signAndSendTransaction'] };
    return { pair, account };
  };
  let current = await makeAccount();
  let accounts: WalletAccount[] = [];
  let trusted = false;

  const fake: FakeSolanaWallet = {
    wallet: undefined as never,
    address: current.account.address,
    sent: [],
    prompts: 0,
    failNext: null,
    verify: (message, signature) => subtle.verify('Ed25519', current.pair.publicKey, new Uint8Array(signature), new Uint8Array(message)),
    async switchAccount() {
      current = await makeAccount();
      fake.address = current.account.address;
      if (trusted) {
        accounts = [current.account];
        for (const listener of [...listeners]) listener({ accounts });
      }
      return current.account.address;
    },
  };

  const signAndSend = {
    version: '1.0.0',
    supportedTransactionVersions: options.versions ?? ['legacy', 0],
    async signAndSendTransaction(...inputs: readonly { account: WalletAccount; transaction: Uint8Array; chain: string }[]) {
      const outputs: { signature: Uint8Array }[] = [];
      for (const { account, transaction, chain } of inputs) {
        if (fake.failNext !== null) {
          const { code, message } = fake.failNext;
          fake.failNext = null;
          throw Object.assign(new Error(message), code === undefined ? {} : { code });
        }
        if (account.address !== current.account.address) throw new Error('the wallet does not hold that account');
        // One signature slot, then the message: the only kind of transaction this wallet is handed.
        if (transaction[0] !== 1) throw new Error('the wallet signs transactions with one signer only');
        const message = transaction.slice(65);
        const signature = new Uint8Array(await subtle.sign('Ed25519', current.pair.privateKey, message));
        const wire = transaction.slice();
        wire.set(signature, 1);
        fake.sent.push({ wire, chain, signature });
        outputs.push({ signature });
      }
      return outputs;
    },
  };

  fake.wallet = {
    version: '1.0.0',
    name: options.name ?? 'Fake Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    chains,
    get accounts() {
      return accounts;
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        async connect(input?: { silent?: boolean }) {
          if (input?.silent === true) return { accounts: trusted ? accounts : [] };
          fake.prompts += 1;
          trusted = true;
          accounts = [current.account];
          return { accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        async disconnect() {
          trusted = false;
          accounts = [];
        },
      },
      'standard:events': {
        version: '1.0.0',
        on(_event: 'change', listener: (properties: { accounts?: readonly WalletAccount[] }) => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      ...(options.features === 'sign-only' ? { 'solana:signTransaction': { version: '1.0.0' } } : { 'solana:signAndSendTransaction': signAndSend }),
    },
  };
  return fake;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** An ECDSA signature as WebCrypto gives it (r then s), in the DER an authenticator answers with. */
function der(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = [...bytes.slice(start)];
    if (((body[0] ?? 0) & 0x80) !== 0) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export interface SoftwareAuthenticator {
  createFn: (options?: unknown) => Promise<never>;
  getFn: (options?: unknown) => Promise<never>;
  /** The options of each creation and each assertion asked of it. */
  created: { rpId: string | undefined; userName: string | undefined; userId: string; residentKey: string | undefined; userVerification: string | undefined }[];
  asserted: { rpId: string | undefined; credentialId: string | undefined; challenge: Uint8Array }[];
  /** The ids of the passkeys it holds, oldest first. */
  held(): string[];
  /** When set, the next ceremony is declined the way a browser reports a dismissed prompt. */
  declineNext: boolean;
  /** The passkey the treasurer picks when the site names none; the newest unless set. */
  pick: string | null;
}

/**
 * A passkey authenticator in software, behind the two functions a browser
 * offers as `navigator.credentials.create` and `.get`. It keeps P-256 keys,
 * binds each to the relying party it was created for, keeps one for each user
 * id of a relying party, and answers an assertion with authenticator data,
 * client data and a DER signature, as WebAuthn has it.
 */
export function softwareAuthenticator(origin = 'https://app.holdfast.test'): SoftwareAuthenticator {
  const keys = new Map<string, { pair: webcrypto.CryptoKeyPair; rpId: string; userId: string }>();
  const declined = () => new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');

  const authenticator: SoftwareAuthenticator = {
    created: [],
    asserted: [],
    held: () => [...keys.keys()],
    declineNext: false,
    pick: null,

    async createFn(options) {
      const { publicKey } = options as { publicKey: { rp?: { id?: string }; user?: { name?: string; id?: Uint8Array }; authenticatorSelection?: { residentKey?: string; userVerification?: string } } };
      const userId = Buffer.from(publicKey.user?.id ?? []).toString('hex');
      authenticator.created.push({ rpId: publicKey.rp?.id, userName: publicKey.user?.name, userId, residentKey: publicKey.authenticatorSelection?.residentKey, userVerification: publicKey.authenticatorSelection?.userVerification });
      if (authenticator.declineNext) {
        authenticator.declineNext = false;
        throw declined();
      }
      // A user id is one to sixty-four bytes; a browser refuses any other before the authenticator is asked.
      if (userId.length < 2 || userId.length > 128) throw new TypeError('the user id is not between 1 and 64 bytes long');
      const rpId = publicKey.rp?.id ?? new URL(origin).hostname;
      // One passkey for each user of a site: a second one for the same user id takes the place of the first.
      for (const [held, key] of keys) if (key.rpId === rpId && key.userId === userId) keys.delete(held);
      const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
      const rawId = webcrypto.getRandomValues(new Uint8Array(16));
      const id = base64url(rawId);
      keys.set(id, { pair, rpId, userId });
      const spki = await subtle.exportKey('spki', pair.publicKey);
      return {
        id,
        rawId: rawId.buffer,
        type: 'public-key',
        response: { attestationObject: new ArrayBuffer(0), clientDataJSON: new ArrayBuffer(0), getPublicKey: () => spki },
      } as never;
    },

    async getFn(options) {
      const { publicKey } = options as { publicKey: { rpId?: string; challenge: Uint8Array; allowCredentials?: { id: Uint8Array }[] } };
      const wanted = publicKey.allowCredentials?.[0]?.id;
      const named = wanted === undefined ? undefined : base64url(wanted);
      authenticator.asserted.push({ rpId: publicKey.rpId, credentialId: named, challenge: new Uint8Array(publicKey.challenge) });
      // With no credential named, the treasurer is offered the passkeys of this site and picks one.
      const offered = [...keys].filter(([, key]) => key.rpId === publicKey.rpId).map(([held]) => held);
      const id = named ?? authenticator.pick ?? offered.at(-1);
      const key = id === undefined ? undefined : keys.get(id);
      // A credential answers only for the relying party it was created under.
      if (authenticator.declineNext || id === undefined || key === undefined || key.rpId !== publicKey.rpId) {
        authenticator.declineNext = false;
        throw declined();
      }
      const rpIdHash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(key.rpId)));
      // User present and user verified, and a signature counter of zero.
      const authenticatorData = new Uint8Array([...rpIdHash, 0x05, 0, 0, 0, 0]);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: base64url(new Uint8Array(publicKey.challenge)), origin, crossOrigin: false }));
      const clientDataHash = new Uint8Array(await subtle.digest('SHA-256', clientDataJSON));
      const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new Uint8Array([...authenticatorData, ...clientDataHash])));
      return {
        id,
        type: 'public-key',
        response: { authenticatorData: authenticatorData.buffer, clientDataJSON: clientDataJSON.buffer, signature: der(signature).buffer },
      } as never;
    },
  };
  return authenticator;
}
