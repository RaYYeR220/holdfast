import { type Address, type Chain, type Hex, type WalletClient, createWalletClient, custom, getAddress, isAddress, isHex, numberToHex } from 'viem';
import { ClientError, walletError } from './errors';

/**
 * The treasurer's EVM wallet: finding the wallets the browser has, connecting
 * to one, and following its account and chain. The address it holds is the
 * organisation's owner and its Hyperliquid account. It signs the sign-in
 * message and the approval of the Hyperliquid agent, and sends the two calls
 * that let the service attest; nothing here builds a call of its own.
 */

/** A wallet's provider as EIP-1193 describes it. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (payload: unknown) => void): unknown;
  removeListener?(event: string, listener: (payload: unknown) => void): unknown;
}

export interface EvmWallet {
  /** Stable while the page lives: the wallet's EIP-6963 uuid, or `injected` for `window.ethereum`. */
  id: string;
  name: string;
  /**
   * A data URI the wallet supplied for itself; null when it gave none. It is
   * the wallet's to choose and may be an SVG, which can carry script: draw it
   * as the source of an image and never as markup.
   */
  icon: string | null;
  /** The wallet's reverse-DNS name, which stays the same between visits; null for `window.ethereum`. */
  rdns: string | null;
  provider: Eip1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const ANNOUNCE = 'eip6963:announceProvider';
const REQUEST = 'eip6963:requestProvider';
/** EIP-6963 has wallets supply their icon as a data URI; anything else is not put where a page would draw it. */
const ICON = /^data:image\//;

function isAnnouncement(detail: unknown): detail is Eip6963Detail {
  if (typeof detail !== 'object' || detail === null) return false;
  const { info, provider } = detail as { info?: Partial<Eip6963Detail['info']>; provider?: Partial<Eip1193Provider> };
  return typeof info?.uuid === 'string' && typeof info.name === 'string' && typeof info.rdns === 'string' && typeof provider?.request === 'function';
}

/** The provider older wallets leave on `window`, for a browser where no wallet announces itself. */
function injected(): EvmWallet | null {
  const provider = (window as { ethereum?: Partial<Eip1193Provider> }).ethereum;
  if (provider === undefined || provider === null || typeof provider.request !== 'function') return null;
  return { id: 'injected', name: 'Browser wallet', icon: null, rdns: null, provider: provider as Eip1193Provider };
}

/**
 * Keep `listener` told of the wallets this browser has. It is called at once
 * with the ones already there, and again whenever another announces itself
 * (EIP-6963). `window.ethereum` is listed only while no wallet has announced
 * itself, since an announcing wallet usually sits there too. Returns the
 * function that stops the watch. Outside a browser it finds nothing.
 */
export function watchEvmWallets(listener: (wallets: EvmWallet[]) => void): () => void {
  if (typeof window === 'undefined') {
    listener([]);
    return () => undefined;
  }
  const announced = new Map<string, EvmWallet>();
  let started = false;
  const tell = () => {
    const fallback = announced.size === 0 ? injected() : null;
    listener(fallback === null ? [...announced.values()] : [fallback]);
  };
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isAnnouncement(detail) || announced.has(detail.info.uuid)) return;
    const { uuid, name, icon, rdns } = detail.info;
    announced.set(uuid, { id: uuid, name, icon: typeof icon === 'string' && ICON.test(icon) ? icon : null, rdns, provider: detail.provider });
    if (started) tell();
  };
  window.addEventListener(ANNOUNCE, onAnnounce);
  // Wallets that are already loaded answer this before it returns.
  window.dispatchEvent(new Event(REQUEST));
  started = true;
  tell();
  return () => window.removeEventListener(ANNOUNCE, onAnnounce);
}

export interface EvmState {
  /** The account the wallet has selected, checksummed; null once the wallet is locked or has withdrawn the site's access. */
  address: Address | null;
  /** The chain the wallet is on; null when it could not be read. */
  chainId: number | null;
}

/** EIP-712 data as the server hands it over: the types without `EIP712Domain`, which the wallet client adds. */
export interface TypedDataInput {
  domain: { name?: string; version?: string; chainId?: number; verifyingContract?: string };
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface EvmConnection {
  readonly wallet: EvmWallet;
  /** A viem wallet client over the wallet's provider, for anything not wrapped here. */
  readonly client: WalletClient;
  state(): EvmState;
  /** Called with the new state whenever the wallet changes account or chain. Returns the function that stops it. */
  subscribe(listener: (state: EvmState) => void): () => void;
  /** The chain the wallet is on, asked of the wallet now. */
  readChainId(): Promise<number>;
  /**
   * `personal_sign` by the selected account. With `by`, the request is made
   * for that account by name, and is not made at all unless the wallet has it
   * selected at that moment.
   */
  signMessage(message: string, by?: string): Promise<Hex>;
  /** `eth_signTypedData_v4` by the selected account; `by` as for `signMessage`. */
  signTypedData(typedData: TypedDataInput, by?: string): Promise<Hex>;
  /**
   * Have the wallet move to a chain (`wallet_switchEthereumChain`). A wallet
   * that does not know the chain is given it first (`wallet_addEthereumChain`)
   * when `add` describes that chain. Resolves once the wallet is on it.
   */
  switchChain(chainId: number, options?: { add?: Chain }): Promise<void>;
  /**
   * Have the wallet send a call (`eth_sendTransaction`). The wallet sets the
   * fee and the nonce. `from` is as `by` above. With `chainId`, the wallet is
   * asked which chain it is on immediately before, nothing is sent from
   * another, and the transaction names the chain so that a wallet that has
   * moved since turns it down. Resolves with the transaction's hash, which
   * says it was sent, not that it was included.
   */
  sendCall(call: { to: string; data: string; from?: string; chainId?: number }): Promise<Hex>;
  /** Stop following the wallet. Nothing is asked of the wallet, which keeps the site's access. */
  close(): void;
  /**
   * Stop following the wallet and ask it to withdraw the site's access
   * (`wallet_revokePermissions`). EIP-1193 has no disconnect of its own, and a
   * wallet that does not know the request simply keeps the permission.
   */
  disconnect(): Promise<void>;
}

function checksummed(value: unknown): Address | null {
  try {
    return typeof value === 'string' ? getAddress(value) : null;
  } catch {
    return null;
  }
}

function chainIdOf(value: unknown): number | null {
  const id = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * EIP-3326 has a wallet answer 4902 for a chain it has not been given.
 * Libraries wrap the answer, so the causes are looked through; MetaMask on
 * a phone wraps it itself, as the original error of an internal one.
 */
function unknownChain(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, data, cause } = current as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: unknown };
    if (code === 4902 || data?.originalError?.code === 4902) return true;
    current = cause;
  }
  return false;
}

/**
 * Connect to a wallet. Ordinarily this asks the wallet for its accounts,
 * which opens it (`eth_requestAccounts`). With `silent` it only asks which
 * accounts the site may already see (`eth_accounts`), opens nothing, and
 * resolves to null when there is none: that is how a page finds a wallet it
 * was connected to on an earlier visit.
 */
export async function connectEvmWallet(wallet: EvmWallet, options?: { silent?: false }): Promise<EvmConnection>;
export async function connectEvmWallet(wallet: EvmWallet, options: { silent: true }): Promise<EvmConnection | null>;
export async function connectEvmWallet(wallet: EvmWallet, options: { silent?: boolean } = {}): Promise<EvmConnection | null> {
  const { provider } = wallet;
  // No request is repeated: a wallet that failed is not asked again behind the treasurer's back.
  const client = createWalletClient({ transport: custom(provider, { retryCount: 0 }) });

  let accounts: readonly unknown[];
  let chain: number | null;
  try {
    accounts = options.silent === true ? await client.getAddresses() : await client.requestAddresses();
    chain = accounts.length === 0 ? null : await client.getChainId();
  } catch (error) {
    throw walletError(error, 'connecting');
  }
  const address = checksummed(accounts[0]);
  if (address === null) {
    if (options.silent === true) return null;
    throw new ClientError('wallet_unavailable', `${wallet.name} shared no account`);
  }

  let current: EvmState = { address, chainId: chain };
  const listeners = new Set<(state: EvmState) => void>();
  const change = (next: EvmState) => {
    if (next.address === current.address && next.chainId === current.chainId) return;
    current = next;
    for (const listener of [...listeners]) listener(current);
  };
  const onAccounts = (changed: unknown) => change({ ...current, address: Array.isArray(changed) ? checksummed(changed[0]) : null });
  const onChain = (changed: unknown) => change({ ...current, chainId: chainIdOf(changed) });
  provider.on?.('accountsChanged', onAccounts);
  provider.on?.('chainChanged', onChain);

  /** The account a request is made for: the selected one, which has to be `by` when one is named. */
  const signer = (by?: string): Address => {
    if (current.address === null) throw new ClientError('wallet_unavailable', `${wallet.name} has no account selected`);
    if (by !== undefined && current.address.toLowerCase() !== by.toLowerCase()) {
      throw new ClientError('wrong_account', `${wallet.name} has ${current.address} selected, and this has to be signed by ${by}`);
    }
    return current.address;
  };
  const close = (): void => {
    provider.removeListener?.('accountsChanged', onAccounts);
    provider.removeListener?.('chainChanged', onChain);
    change({ address: null, chainId: null });
    listeners.clear();
  };
  const readChainId = async (): Promise<number> => {
    try {
      const id = await client.getChainId();
      change({ ...current, chainId: id });
      return id;
    } catch (error) {
      throw walletError(error, 'reading the chain');
    }
  };
  const switchTo = async (chainId: number): Promise<void> => {
    try {
      await client.switchChain({ id: chainId });
    } catch (error) {
      throw walletError(error, 'switching chain');
    }
  };

  return {
    wallet,
    client,
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    readChainId,
    async signMessage(message, by) {
      const account = signer(by);
      try {
        return await client.signMessage({ account, message });
      } catch (error) {
        throw walletError(error, 'signing the message');
      }
    },
    async signTypedData(typedData, by) {
      const account = signer(by);
      try {
        return await client.signTypedData({ account, ...typedData } as Parameters<typeof client.signTypedData>[0]);
      } catch (error) {
        throw walletError(error, 'signing');
      }
    },
    async switchChain(chainId, options = {}) {
      const chain = options.add;
      let added = false;
      try {
        await switchTo(chainId);
      } catch (error) {
        if (chain === undefined || chain.id !== chainId || !unknownChain(error)) throw error;
        try {
          await client.addChain({ chain });
        } catch (refusal) {
          throw walletError(refusal, 'adding the chain');
        }
        added = true;
      }
      // A wallet may add a chain without moving to it, and the page is told of a move only afterwards: the wallet is asked.
      let reached = await readChainId();
      if (reached !== chainId && added) {
        await switchTo(chainId);
        reached = await readChainId();
      }
      if (reached !== chainId) throw new ClientError('wallet_failed', `${wallet.name} stayed on chain ${reached} when asked to move to chain ${chainId}`);
    },
    async sendCall(call) {
      if (!isAddress(call.to) || !isHex(call.data)) throw new ClientError('invalid_argument', 'a call is an address and hex data');
      const { chainId } = call;
      if (chainId !== undefined) {
        if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new ClientError('invalid_argument', `${chainId} is not a chain id`);
        const on = await readChainId();
        if (on !== chainId) throw new ClientError('wallet_failed', `${wallet.name} is on chain ${on}, and the transaction is for chain ${chainId}; nothing was sent`);
      }
      // After the last thing awaited, so that it is the account selected now.
      const from = signer(call.from);
      try {
        return await client.request({ method: 'eth_sendTransaction', params: [{ from, to: call.to, data: call.data, ...(chainId === undefined ? {} : { chainId: numberToHex(chainId) }) }] });
      } catch (error) {
        throw walletError(error, 'sending the transaction');
      }
    },
    close,
    async disconnect() {
      close();
      try {
        await provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
      } catch {
        // The wallet does not know the request and keeps the permission; this side has let go of it all the same.
      }
    },
  };
}

/** Whether two account addresses are the same account. Both are hex and compared without case. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}
