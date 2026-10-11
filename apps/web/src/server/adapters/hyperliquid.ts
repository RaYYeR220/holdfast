import { approveAgentAction, createHedgeVenue, generateAgentKey, probeWithdrawRefusal, submitApproveAgent } from '@holdfast/hyperliquid';
import type { HoldfastNetwork } from '../config';
import type { HyperliquidPort } from '../deps';

export interface HyperliquidIo {
  fetch?: typeof fetch;
  now?: () => number;
}

/** Hyperliquid on one network. `io` replaces the network and the clock in tests. */
export function hyperliquidPort(network: HoldfastNetwork, io: HyperliquidIo = {}): HyperliquidPort {
  return {
    network,
    newAgentKey: generateAgentKey,
    venue: (agentPrivateKey) => createHedgeVenue({ network, agentPrivateKey, fetch: io.fetch, now: io.now }),
    approvalRequest: (terms) => approveAgentAction({ ...terms, network }),
    submitApproval: (terms) => submitApproveAgent({ ...terms, network, fetch: io.fetch }),
    probeWithdrawal: (i) => probeWithdrawRefusal({ ...i, network, fetch: io.fetch, now: io.now }),
  };
}
