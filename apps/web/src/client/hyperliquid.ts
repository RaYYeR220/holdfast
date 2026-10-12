import { recoverTypedDataAddress } from 'viem';
import type { AGENT_NAME } from '../server/hyperliquid/service';
import { type Api, type HyperliquidApproval, type HyperliquidApprovalRequest, api as defaultApi } from './api';
import { ClientError } from './errors';
import { type EvmConnection, type TypedDataInput, sameAddress } from './evm';

/**
 * Approving the organisation's Hyperliquid agent. The server builds the
 * typed data, the owner's wallet signs it, and the server hands the signature
 * to Hyperliquid. An agent can place and cancel orders for the account; it
 * cannot withdraw from it.
 */

/**
 * The name the agent is approved under. Approving a name replaces whichever
 * agent held it, so no other name is ever signed for: an approval under
 * another would put out an agent of the treasurer's own. The type holds this
 * to the name the server uses.
 */
export const HYPERLIQUID_AGENT_NAME: typeof AGENT_NAME = 'holdfast';

export type HyperliquidNetwork = 'Mainnet' | 'Testnet';

const APPROVE_AGENT = 'HyperliquidTransaction:ApproveAgent';
const NO_CONTRACT = '0x0000000000000000000000000000000000000000';
const HYPERLIQUID_CHAINS: readonly unknown[] = ['Mainnet', 'Testnet'] satisfies HyperliquidNetwork[];

export interface ApprovalTerms {
  /** The chain the signing wallet is on. It is part of the EIP-712 domain and of nothing else. */
  chainId: number;
  /** `Mainnet` or `Testnet`: which Hyperliquid the approval is for. */
  hyperliquidChain: string;
  agentAddress: string;
  agentName: string;
  /** Millisecond timestamp; the replay nonce of the action. */
  nonce: number;
  /** When the approval lapses, in ms; left out, it does not. */
  validUntil?: number;
}

/**
 * The typed data of an agent approval and of nothing else. Hyperliquid's
 * signing domain also covers withdrawals and transfers, so what the wallet is
 * asked to sign is built here from the terms, not taken from an answer.
 */
export function approveAgentTypedData(terms: ApprovalTerms): TypedDataInput {
  return {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: terms.chainId, verifyingContract: NO_CONTRACT },
    types: {
      [APPROVE_AGENT]: [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' },
      ],
    },
    primaryType: APPROVE_AGENT,
    message: {
      hyperliquidChain: terms.hyperliquidChain,
      agentAddress: terms.agentAddress,
      // Hyperliquid reads the expiry out of the name itself.
      agentName: terms.validUntil === undefined ? terms.agentName : `${terms.agentName} valid_until ${terms.validUntil}`,
      nonce: terms.nonce,
    },
  };
}

/** A value written so that two of the same content are the same text: object keys in order, lists as they are. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const fields = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${fields.map(([name, field]) => `${JSON.stringify(name)}:${canonical(field)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export interface ApprovalExpectation {
  /** The chain the wallet is on. */
  chainId: number;
  /** When the approval lapses, in ms, as the caller asked for it; left out, the approval must carry no expiry. */
  validUntil?: number;
  /** Which Hyperliquid the approval may be for, where the caller knows; left out, either. */
  network?: HyperliquidNetwork;
}

/**
 * The typed data to sign for a request of the server. It is rebuilt here:
 * the kind of action, the name, the chain and the expiry are this side's, and
 * only the agent's address, the nonce and the network are the server's to
 * say. The server's own typed data has to be exactly that, or nothing is
 * signed. A request for another chain than the wallet's, under another name,
 * with an expiry nobody asked for, or one that is not an agent approval at
 * all, never reaches the wallet.
 */
export function checkedApprovalTypedData(request: HyperliquidApprovalRequest, expectation: ApprovalExpectation): TypedDataInput {
  const refuse = (why: string) => new ClientError('unexpected_request', `the approval the server prepared ${why}; nothing was signed`);
  const { chainId, validUntil, network } = expectation;
  const { hyperliquidChain, agentAddress }: Record<string, unknown> = request.typedData.message;
  if (typeof hyperliquidChain !== 'string' || !HYPERLIQUID_CHAINS.includes(hyperliquidChain)) throw refuse('names no Hyperliquid network');
  if (network !== undefined && hyperliquidChain !== network) throw refuse(`is for Hyperliquid ${hyperliquidChain}, not ${network}`);
  // Hyperliquid writes addresses in lower case; the agent is the same one however it is written.
  if (typeof agentAddress !== 'string' || !sameAddress(agentAddress, request.agentAddress)) throw refuse('is for another agent than it names');
  if (request.agentName !== HYPERLIQUID_AGENT_NAME) throw refuse(`is under the name "${String(request.agentName)}", not "${HYPERLIQUID_AGENT_NAME}"`);
  if (!Number.isSafeInteger(request.nonce) || request.nonce <= 0) throw refuse('carries a nonce that is not a time');
  if (validUntil !== undefined && (!Number.isSafeInteger(validUntil) || validUntil <= request.nonce)) throw new ClientError('invalid_argument', 'the approval has to lapse after it is made');
  const expected = approveAgentTypedData({
    chainId,
    hyperliquidChain,
    agentAddress,
    agentName: HYPERLIQUID_AGENT_NAME,
    nonce: request.nonce,
    ...(validUntil === undefined ? {} : { validUntil }),
  });
  if (canonical(request.typedData) !== canonical(expected)) throw refuse('is something other than the approval of the agent on the chain of the wallet');
  return expected;
}

export interface ApproveAgentOptions {
  api?: Api;
  /** When the approval lapses, in ms. Hyperliquid allows at most 180 days ahead. */
  validUntil?: number;
  /**
   * Which Hyperliquid this deployment trades on, where the page knows it. The
   * server says nowhere else which it is, so without this the approval is
   * signed for the network the server names, which the wallet shows.
   */
  network?: HyperliquidNetwork;
}

/**
 * Approve the organisation's agent with the owner's wallet.
 *
 * Hyperliquid binds a user-signed action to the chain id in its EIP-712
 * domain but accepts any chain id there, and wallets refuse typed data for a
 * chain they are not on. The server builds the data for whichever chain it is
 * asked for, so it is asked for the chain the wallet is on now and the wallet
 * is never made to switch: a switch can fail on a wallet that lacks the
 * chain, and it changes something the treasurer did not ask to have changed.
 * The same chain id goes back with the signature, since it is part of what
 * the server checks the signature against.
 *
 * The wallet has to hold the organisation's owner: Hyperliquid applies the
 * approval to whoever signed, and the server sends nothing signed by anyone
 * else. That is settled before the wallet is opened, the wallet is asked to
 * sign as that account by name, and the signature leaves this side only if
 * it is that account's.
 */
export async function approveHyperliquidAgent(connection: EvmConnection, orgId: string, options: ApproveAgentOptions = {}): Promise<HyperliquidApproval> {
  const api = options.api ?? defaultApi;
  const org = await api.getOrg(orgId);
  const { address } = connection.state();
  if (!sameAddress(address, org.owner)) {
    throw new ClientError('wrong_account', `the wallet holds ${address ?? 'no account'}, and the approval has to be signed by ${org.owner}, which owns the organisation`);
  }

  const chainId = await connection.readChainId();
  const { validUntil, network } = options;
  const request = await api.hyperliquidApproval(orgId, { chainId, ...(validUntil === undefined ? {} : { validUntil }) });
  const agent = org.serviceKeys.find((key) => key.kind === 'hl_agent');
  if (agent === undefined || !sameAddress(agent.address, request.agentAddress)) {
    throw new ClientError('unexpected_request', 'the approval the server prepared is not for the agent key of this organisation; nothing was signed');
  }
  const typedData = checkedApprovalTypedData(request, { chainId, ...(validUntil === undefined ? {} : { validUntil }), ...(network === undefined ? {} : { network }) });

  const signature = await connection.signTypedData(typedData, org.owner);
  let signedBy: string;
  try {
    signedBy = await recoverTypedDataAddress({ ...typedData, signature } as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch (error) {
    throw new ClientError('wallet_failed', 'the wallet answered with something that is not a signature', { cause: error });
  }
  if (!sameAddress(signedBy, org.owner)) {
    throw new ClientError('wrong_account', `the wallet signed as ${signedBy}, not as ${org.owner}, which owns the organisation; the signature was not passed on`);
  }
  return api.submitHyperliquidApproval(orgId, {
    nonce: request.nonce,
    signature,
    signatureChainId: chainId,
    ...(validUntil === undefined ? {} : { validUntil }),
  });
}
