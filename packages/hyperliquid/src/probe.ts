import { UsdSendTypes, Withdraw3Types } from '@nktkas/hyperliquid/api/exchange';
import { signUserSignedAction } from '@nktkas/hyperliquid/signing';
import type { LocalAccount } from 'viem/accounts';
import { createTransport, isExchangeRefusal, type Network, postExchange, type Transport, type TransportOptions } from './client';
import { HyperliquidError } from './errors';
import { agentAccount, type Hex } from './signing';
import { normalizeUser } from './state';

export interface ProbeParams extends Pick<TransportOptions, 'fetch' | 'now' | 'timeoutMs'> {
  agentPrivateKey: string;
  network: Network;
  /** The team's account. It is the only destination the probe ever names. */
  user: string;
  /** Dollars to ask for. Above the $1 withdrawal fee, so the size is not a reason to say no. */
  amount?: string;
}

export interface ProbeAttempt {
  /** The action exactly as the agent key signed it. */
  attempted: Record<string, unknown>;
  /** True only when Hyperliquid processed the action and answered with an error status. */
  refused: boolean;
  /** Hyperliquid's response body, verbatim; null when none arrived. */
  response: unknown;
  httpStatus: number | null;
  /** Why the attempt proves nothing: no answer, or an answer that is not a refusal. */
  error: string | null;
}

export interface WithdrawRefusalProbe {
  agentAddress: Hex;
  user: Hex;
  withdraw3: ProbeAttempt;
  usdSend: ProbeAttempt;
}

const SIGNATURE_CHAIN_ID: Record<Network, Hex> = { mainnet: '0xa4b1', testnet: '0x66eee' };
const DEFAULT_AMOUNT = '5';

async function attempt(
  transport: Transport,
  agent: LocalAccount,
  type: 'withdraw3' | 'usdSend',
  types: Record<string, { name: string; type: string }[]>,
  destination: Hex,
  amount: string,
  time: number,
): Promise<ProbeAttempt> {
  const action = {
    type,
    signatureChainId: SIGNATURE_CHAIN_ID[transport.network],
    hyperliquidChain: transport.network === 'mainnet' ? 'Mainnet' : 'Testnet',
    destination,
    amount,
    time,
  };
  const signature = await signUserSignedAction({ wallet: agent, action, types });
  const reply = await postExchange(transport, { action, nonce: time, signature });

  const refused = isExchangeRefusal(reply);
  let error: string | null = null;
  if (!refused) {
    error = reply.ok ? `Hyperliquid accepted a ${type} signed by the agent key` : reply.error;
  }
  return { attempted: action, refused, response: reply.response, httpStatus: reply.httpStatus, error };
}

/**
 * Evidence that the agent key cannot move money: it signs a bridge withdrawal
 * and an internal USD transfer and both answers are returned as received.
 *
 * Withdrawals and transfers are user-signed actions with no "on behalf of"
 * field. Hyperliquid applies them to the account of whoever signed, so an
 * agent's signature speaks only for the agent's own, empty, address. The
 * destination is always the team's account: nothing here could send funds
 * anywhere else even if an answer came back positive.
 */
export async function probeWithdrawRefusal(params: ProbeParams): Promise<WithdrawRefusalProbe> {
  const agent = agentAccount(params.agentPrivateKey);
  const user = normalizeUser(params.user);
  const amount = params.amount ?? DEFAULT_AMOUNT;
  if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
    throw new HyperliquidError('INVALID_ARGUMENT', `amount must be a positive decimal, got "${amount}"`);
  }

  const transport = createTransport(params);
  const time = transport.now();
  // One after the other: the two actions share a signer, and a nonce is good only once.
  const withdraw3 = await attempt(transport, agent, 'withdraw3', Withdraw3Types, user, amount, time);
  const usdSend = await attempt(transport, agent, 'usdSend', UsdSendTypes, user, amount, time + 1);

  return { agentAddress: agent.address.toLowerCase() as Hex, user, withdraw3, usdSend };
}
