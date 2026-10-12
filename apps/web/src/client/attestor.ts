import { type Chain, type Hex, encodeFunctionData, getAddress, isAddress } from 'viem';
import { hyperEvm, hyperliquidEvmTestnet } from 'viem/chains';
import { type Api, type Attestor, api as defaultApi } from './api';
import { ClientError } from './errors';
import { type EvmConnection, sameAddress } from './evm';

/**
 * Letting the service attest. The HedgeAttestor contract on HyperEVM records
 * snapshots of the organisation's hedge, signed by a key of the service. That
 * key may only record for the organisation once the organisation's own
 * account has named it, and only that account can start a new series. The
 * server prepares both calls; the owner's wallet sends them.
 */

/** The two functions of the contract the owner calls, as the contract declares them. */
const OWNER_CALLS = [
  { type: 'function', name: 'setAttester', inputs: [{ name: 'attester', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'startSeries', inputs: [], outputs: [{ name: 'series', type: 'uint256' }], stateMutability: 'nonpayable' },
] as const;

/** The chains the contract can be on. A call for any other chain is not sent. */
const CHAINS: readonly Chain[] = [hyperEvm, hyperliquidEvmTestnet];

export interface SentCall {
  /** The hash of the transaction the wallet sent. It says the wallet sent it, not that the chain has it. */
  hash: Hex;
  chainId: number;
  /** The contract the call went to. */
  contract: string;
}

export interface AttestorOptions {
  api?: Api;
}

/** What the server says of the organisation's attester, held against what it says of the organisation itself. */
async function read(api: Api, orgId: string): Promise<Attestor> {
  const [org, view] = await Promise.all([api.getOrg(orgId), api.attestor(orgId)]);
  if (!sameAddress(view.account, org.owner)) {
    throw new ClientError('unexpected_request', 'the server names another account for attesting than the one that owns the organisation; nothing was sent');
  }
  const key = org.serviceKeys.find((candidate) => candidate.kind === 'hl_attester');
  if (view.attester !== null && (key === undefined || !sameAddress(key.address, view.attester))) {
    throw new ClientError('unexpected_request', 'the attester the server names is not the attester key of this organisation; nothing was sent');
  }
  return view;
}

/**
 * Send one of the owner's calls, once it is settled that it is that call
 * and nothing else: to the contract the server names, on HyperEVM, carrying
 * exactly the data the function encodes to here. The wallet is moved to the
 * chain first, and is given the chain if it does not know it. Which contract
 * it is, is the server's to say: this side knows the chain and the call, and
 * the wallet shows the address.
 */
async function send(connection: EvmConnection, view: Attestor, prepared: Attestor['setAttester'], expectedData: Hex, what: string): Promise<SentCall> {
  if (prepared === null || view.contract === null || view.chainId === null) {
    throw new ClientError('nothing_to_sign', view.contract === null ? 'this deployment records no attestations' : `there is nothing to send to ${what}: the organisation has no attester key`);
  }
  const { address } = connection.state();
  if (!sameAddress(address, view.account)) {
    throw new ClientError('wrong_account', `the wallet holds ${address ?? 'no account'}, and only ${view.account}, the account of the organisation, can ${what}`);
  }
  const { chainId } = view;
  const chain = CHAINS.find((known) => known.id === chainId);
  if (chain === undefined || !isAddress(view.contract) || !sameAddress(prepared.to, view.contract) || prepared.chainId !== chainId || prepared.data.toLowerCase() !== expectedData.toLowerCase()) {
    throw new ClientError('unexpected_request', `the server prepared something other than the call to ${what} on HyperEVM; nothing was sent`);
  }

  if ((await connection.readChainId()) !== chainId) await connection.switchChain(chainId, { add: chain });
  // The data sent is the data encoded here, from the account and on the chain settled above; the wallet is held to both.
  const hash = await connection.sendCall({ to: view.contract, data: expectedData, from: view.account, chainId });
  return { hash, chainId, contract: view.contract };
}

/**
 * Name the organisation's attester key as the one that may record its
 * snapshots: `setAttester(attester)`, sent from the organisation's account
 * on HyperEVM. Resolves once the wallet has sent it; `waitForAttester` says
 * when the chain shows it.
 */
export async function registerAttester(connection: EvmConnection, orgId: string, options: AttestorOptions = {}): Promise<SentCall> {
  const view = await read(options.api ?? defaultApi, orgId);
  if (view.contract === null) throw new ClientError('nothing_to_sign', 'this deployment records no attestations');
  if (view.attester === null || !isAddress(view.attester)) throw new ClientError('nothing_to_sign', 'the organisation has no attester key to name');
  const data = encodeFunctionData({ abi: OWNER_CALLS, functionName: 'setAttester', args: [getAddress(view.attester)] });
  return send(connection, view, view.setAttester, data, 'name the attester');
}

/**
 * Close the current series of snapshots and start the next: `startSeries()`,
 * sent from the organisation's account. The contract refuses it while the
 * current series is empty, and a transaction it refuses is a failed one on
 * chain: `attestations` says whether a new series is what attesting waits for.
 */
export async function startAttestationSeries(connection: EvmConnection, orgId: string, options: AttestorOptions = {}): Promise<SentCall> {
  const view = await read(options.api ?? defaultApi, orgId);
  return send(connection, view, view.startSeries, encodeFunctionData({ abi: OWNER_CALLS, functionName: 'startSeries' }), 'start a new series');
}

export interface AttesterWaitOptions extends AttestorOptions {
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
 * Wait until the server reads from the chain that the organisation's key is
 * the attester its account has named. Rejects with `not_confirmed` when the
 * chain does not show it in time, which does not mean the transaction failed;
 * its details hold the last reading.
 */
export async function waitForAttester(orgId: string, options: AttesterWaitOptions = {}): Promise<Attestor> {
  const api = options.api ?? defaultApi;
  const attempts = options.attempts ?? 20;
  const sleep = options.sleep ?? pause;
  let last: Attestor | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(options.intervalMs ?? 3_000);
    if (options.signal?.aborted === true) throw new ClientError('aborted', 'the wait was given up');
    last = await api.attestor(orgId, options.signal === undefined ? {} : { signal: options.signal });
    if (last.registered.status === 'ok' && last.registered.value.registered) return last;
  }
  throw new ClientError('not_confirmed', 'the chain does not show the attester as registered yet', { details: { registered: last?.registered ?? null } });
}
