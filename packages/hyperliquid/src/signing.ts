import { ApproveAgentTypes, UserSetAbstractionTypes } from '@nktkas/hyperliquid/api/exchange';
import { signL1Action } from '@nktkas/hyperliquid/signing';
import { isHex, parseSignature, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, type LocalAccount, privateKeyToAccount } from 'viem/accounts';
import { createTransport, type ExchangeReply, type Network, postExchange, type TransportOptions } from './client';
import { HyperliquidError } from './errors';
import { normalizeUser } from './state';

export type Hex = `0x${string}`;

export interface WireSignature {
  r: Hex;
  s: Hex;
  v: 27 | 28;
}

type HyperliquidChain = 'Mainnet' | 'Testnet';

const HYPERLIQUID_CHAIN: Record<Network, HyperliquidChain> = { mainnet: 'Mainnet', testnet: 'Testnet' };

/**
 * `signatureChainId` only names the chain the signing wallet is connected to;
 * Hyperliquid accepts any value. Browser wallets refuse typed data whose
 * chainId differs from their active chain, so the default is Arbitrum (One on
 * mainnet, Sepolia on testnet), where Hyperliquid deposits come from.
 */
const DEFAULT_SIGNATURE_CHAIN_ID: Record<Network, number> = { mainnet: 42_161, testnet: 421_614 };

const MAX_AGENT_NAME_LENGTH = 16;
const SIGNATURE_HEX_LENGTH = 132;

type TypedDataFields = { name: string; type: string }[];

/** EIP-712 payload in the shape `walletClient.signTypedData` of viem takes. */
export interface TypedData {
  domain: {
    name: 'HyperliquidSignTransaction';
    version: '1';
    chainId: number;
    verifyingContract: '0x0000000000000000000000000000000000000000';
  };
  types: Record<string, TypedDataFields>;
  primaryType: string;
  message: Record<string, string | number>;
}

type UserSignedBase = {
  type: string;
  signatureChainId: Hex;
  hyperliquidChain: HyperliquidChain;
  nonce: number;
};

export interface UserSignedRequest<TAction extends UserSignedBase> {
  /** What the account owner signs in the browser. */
  typedData: TypedData;
  /** Body of `POST /exchange`, complete except for `signature: { r, s, v }`. */
  body: { action: TAction; nonce: number };
}

function requireNonce(nonce: number): void {
  if (!Number.isSafeInteger(nonce) || nonce <= 0) {
    throw new HyperliquidError('INVALID_ARGUMENT', `nonce must be a millisecond timestamp, got ${nonce}`);
  }
}

function chainFields(network: Network, signatureChainId: number | undefined) {
  const chainId = signatureChainId ?? DEFAULT_SIGNATURE_CHAIN_ID[network];
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new HyperliquidError('INVALID_ARGUMENT', `signatureChainId must be a positive integer, got ${chainId}`);
  }
  return {
    chainId,
    signatureChainId: `0x${chainId.toString(16)}` as Hex,
    hyperliquidChain: HYPERLIQUID_CHAIN[network],
  };
}

/**
 * User-signed actions are plain EIP-712 over the fields listed in `types`, in
 * the `HyperliquidSignTransaction` domain. `type` and `signatureChainId`
 * travel in the request body but are not part of the signed struct.
 */
function userSignedRequest<TAction extends UserSignedBase>(
  types: Record<string, TypedDataFields>,
  action: TAction,
  chainId: number,
): UserSignedRequest<TAction> {
  const [primaryType, fields] = Object.entries(types)[0] ?? [];
  if (primaryType === undefined || fields === undefined) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'typed data definition is empty');
  }
  const values = new Map<string, unknown>(Object.entries(action));
  const message: Record<string, string | number> = {};
  for (const field of fields) {
    const value = values.get(field.name);
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new HyperliquidError('INVALID_ARGUMENT', `action has no value for signed field ${field.name}`);
    }
    message[field.name] = value;
  }
  return {
    typedData: {
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: { [primaryType]: fields.map((field) => ({ ...field })) },
      primaryType,
      message,
    },
    body: { action, nonce: action.nonce },
  };
}

/** 65-byte signature as wallets return it, split the way Hyperliquid wants it. */
export function toWireSignature(signature: string): WireSignature {
  if (!isHex(signature) || signature.length !== SIGNATURE_HEX_LENGTH) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'signature must be a 65-byte hex string');
  }
  try {
    const { r, s, yParity } = parseSignature(signature);
    return { r, s, v: yParity === 0 ? 27 : 28 };
  } catch (error) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'signature is not a valid secp256k1 signature', { cause: error });
  }
}

interface Submission extends Pick<TransportOptions, 'fetch' | 'timeoutMs'> {
  /** The account that must have produced the signature. */
  user: string;
  /** Signature returned by `walletClient.signTypedData(typedData)`. */
  signature: string;
}

/**
 * Hyperliquid applies a user-signed action to whoever the signature recovers
 * to. Checking the signer first means a wallet connected to the wrong account
 * is turned away here instead of quietly changing that other account.
 */
async function submitUserSigned<TAction extends UserSignedBase>(
  network: Network,
  request: UserSignedRequest<TAction>,
  submission: Submission,
): Promise<ExchangeReply> {
  const notSent = (error: string): ExchangeReply => ({
    ok: false,
    delivered: false,
    httpStatus: null,
    response: null,
    error: `not sent: ${error}`,
  });

  const expected = normalizeUser(submission.user);
  let signature: WireSignature;
  let signer: string;
  try {
    signature = toWireSignature(submission.signature);
    signer = await recoverTypedDataAddress({ ...request.typedData, signature: submission.signature as Hex });
  } catch (error) {
    return notSent(error instanceof Error ? error.message : String(error));
  }
  if (signer.toLowerCase() !== expected) {
    return notSent(`signed by ${signer.toLowerCase()}, expected ${expected}`);
  }

  const transport = createTransport({ network, fetch: submission.fetch, timeoutMs: submission.timeoutMs });
  return postExchange(transport, { ...request.body, signature });
}

export interface ApproveAgentParams {
  agentAddress: string;
  /** 1 to 16 characters. Approving a name again replaces the agent that held it. */
  agentName: string;
  network: Network;
  /** Millisecond timestamp; doubles as the replay nonce of the action. */
  nonce: number;
  /** Chain id of the chain the signing wallet is on. */
  signatureChainId?: number;
  /** When the approval lapses (ms). Hyperliquid allows at most 180 days ahead. */
  validUntil?: number;
}

export type ApproveAgentAction = UserSignedBase & {
  type: 'approveAgent';
  agentAddress: Hex;
  agentName: string;
};

/**
 * Typed data and request body that let the team's own wallet authorise an
 * agent key. The agent can trade for the account; it cannot withdraw from it.
 */
export function approveAgentAction(params: ApproveAgentParams): UserSignedRequest<ApproveAgentAction> {
  requireNonce(params.nonce);
  const name = params.agentName;
  if (name.length === 0 || name.length > MAX_AGENT_NAME_LENGTH || name.includes(' valid_until ')) {
    throw new HyperliquidError('INVALID_ARGUMENT', `agentName must be 1 to ${MAX_AGENT_NAME_LENGTH} characters`);
  }
  if (params.validUntil !== undefined && (!Number.isSafeInteger(params.validUntil) || params.validUntil <= params.nonce)) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'validUntil must be a millisecond timestamp after the nonce');
  }

  const { chainId, signatureChainId, hyperliquidChain } = chainFields(params.network, params.signatureChainId);
  const action: ApproveAgentAction = {
    type: 'approveAgent',
    signatureChainId,
    hyperliquidChain,
    agentAddress: normalizeUser(params.agentAddress),
    // Hyperliquid reads an expiry out of the name itself.
    agentName: params.validUntil === undefined ? name : `${name} valid_until ${params.validUntil}`,
    nonce: params.nonce,
  };
  return userSignedRequest(ApproveAgentTypes, action, chainId);
}

/** Send an agent approval that the master wallet signed. Takes the same parameters the builder took. */
export function submitApproveAgent(params: ApproveAgentParams & Submission): Promise<ExchangeReply> {
  return submitUserSigned(params.network, approveAgentAction(params), params);
}

/** The modes this adapter can read back; portfolio margin is deliberately left out. */
export type SettableAbstraction = 'unifiedAccount' | 'disabled';

export interface UserSetAbstractionParams {
  /** The account whose mode changes; it is also the account that signs. */
  user: string;
  abstraction: SettableAbstraction;
  network: Network;
  nonce: number;
  signatureChainId?: number;
}

export type UserSetAbstractionAction = UserSignedBase & {
  type: 'userSetAbstraction';
  user: Hex;
  abstraction: SettableAbstraction;
};

/** Typed data and request body for the account owner to switch between standard and unified account. */
export function userSetAbstractionAction(params: UserSetAbstractionParams): UserSignedRequest<UserSetAbstractionAction> {
  requireNonce(params.nonce);
  const { chainId, signatureChainId, hyperliquidChain } = chainFields(params.network, params.signatureChainId);
  const action: UserSetAbstractionAction = {
    type: 'userSetAbstraction',
    signatureChainId,
    hyperliquidChain,
    user: normalizeUser(params.user),
    abstraction: params.abstraction,
    nonce: params.nonce,
  };
  return userSignedRequest(UserSetAbstractionTypes, action, chainId);
}

export function submitUserSetAbstraction(
  params: UserSetAbstractionParams & Pick<Submission, 'signature' | 'fetch' | 'timeoutMs'>,
): Promise<ExchangeReply> {
  return submitUserSigned(params.network, userSetAbstractionAction(params), params);
}

export function agentAccount(privateKey: string): LocalAccount {
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new HyperliquidError('INVALID_ARGUMENT', 'agent private key must be 32 bytes of hex');
  }
  return privateKeyToAccount(privateKey);
}

/**
 * Sign an L1 action (orders and other trading actions) with an agent key.
 * Hyperliquid hashes the msgpack encoding of the action together with the
 * nonce and has the key sign a "phantom agent" struct carrying that hash, so
 * the key order of `action` is part of what gets signed.
 */
export function signL1(account: LocalAccount, network: Network, action: Record<string, unknown>, nonce: number): Promise<WireSignature> {
  return signL1Action({ wallet: account, action, nonce, isTestnet: network === 'testnet' });
}

const AGENT_ABSTRACTION_CODE: Record<SettableAbstraction, 'u' | 'i'> = { unifiedAccount: 'u', disabled: 'i' };

export interface AgentSetAbstractionParams extends Pick<TransportOptions, 'fetch' | 'now' | 'timeoutMs'> {
  agentPrivateKey: string;
  abstraction: SettableAbstraction;
  network: Network;
}

/**
 * Switch the account mode with the agent key instead of the owner's wallet.
 * Hyperliquid lets an approved agent do this on its own.
 */
export async function agentSetAbstraction(params: AgentSetAbstractionParams): Promise<ExchangeReply> {
  const account = agentAccount(params.agentPrivateKey);
  const transport = createTransport(params);
  const action = { type: 'agentSetAbstraction', abstraction: AGENT_ABSTRACTION_CODE[params.abstraction] };
  const nonce = transport.now();
  const signature = await signL1(account, params.network, action, nonce);
  return postExchange(transport, { action, nonce, signature });
}

/** A fresh key for an agent wallet. The address is lowercase, the way Hyperliquid reports agents. */
export function generateAgentKey(): { privateKey: Hex; address: Hex } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address.toLowerCase() as Hex };
}
