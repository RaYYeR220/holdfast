import {
  address,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { broadcastOf, type Broadcast, type FollowOptions } from './confirm';
import { connect, loadKeyPairSigner, type RpcSource, type SettledCommitment, type SolanaRpc } from './connection';
import { fetchRentRates, type RentRates } from './cost';
import { payoutMessage, type PayoutPlan } from './payout';

export interface SolanaPayoutRailConfig extends RpcSource {
  /** Mint of the token being paid out. */
  mint: string;
  decimals: number;
  /**
   * The service key, as bytes or base58. It is the delegate that moves the
   * tokens and the fee payer: it needs SOL for fees and for the rent of any
   * payee token account a run has to create.
   */
  delegateSecretKey: Uint8Array | string;
  /** How settled chain state must be before the rail relies on it. Defaults to `confirmed`. */
  commitment?: SettledCommitment;
  /**
   * The most payee token accounts one run may create. The service key pays
   * the rent of each and the payee keeps it, so a run that names many fresh
   * addresses is a way to drain the key. Defaults to 3.
   */
  maxNewTokenAccountsPerRun?: number;
  /** How often to ask the node whether a sent transaction has settled, ms. */
  pollIntervalMs?: number;
  /** How long to keep asking before the outcome is reported as unknown, ms. Defaults to two minutes. */
  confirmTimeoutMs?: number;
}

/** The configuration of a rail, resolved, with the things every operation needs. */
export interface RailContext {
  rpc: SolanaRpc;
  mint: Address;
  decimals: number;
  commitment: SettledCommitment;
  pollIntervalMs: number;
  maxNewTokenAccounts: number;
  /** How a sent transaction is followed until it settles. */
  following: FollowOptions;
  /** The service key, loaded on first use. */
  delegate(): Promise<KeyPairSigner>;
  /** Rent-exempt minimums as the node reports them, fetched once. */
  rent(): Promise<RentRates>;
  /** Give a plan a fresh blockhash and the delegate's signature. */
  sign(plan: PayoutPlan): Promise<Broadcast>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_NEW_TOKEN_ACCOUNTS = 3;

export function createRailContext(config: SolanaPayoutRailConfig): RailContext {
  const maxNewTokenAccounts = config.maxNewTokenAccountsPerRun ?? DEFAULT_MAX_NEW_TOKEN_ACCOUNTS;
  if (!Number.isInteger(maxNewTokenAccounts) || maxNewTokenAccounts < 0) {
    throw new RangeError(`invalid maxNewTokenAccountsPerRun ${maxNewTokenAccounts}`);
  }
  const rpc = connect(config);
  const commitment = config.commitment ?? 'confirmed';
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let loadedKey: Promise<KeyPairSigner> | undefined;
  let rentRates: Promise<RentRates> | undefined;

  return {
    rpc,
    mint: address(config.mint),
    decimals: config.decimals,
    commitment,
    pollIntervalMs,
    maxNewTokenAccounts,
    following: {
      commitment,
      pollIntervalMs,
      ...(config.confirmTimeoutMs === undefined ? {} : { deadlineMs: config.confirmTimeoutMs }),
    },
    delegate: () => (loadedKey ??= loadKeyPairSigner(config.delegateSecretKey)),
    rent: () =>
      (rentRates ??= fetchRentRates(rpc).catch((error: unknown) => {
        // A failed fetch is not an answer worth keeping.
        rentRates = undefined;
        throw error;
      })),
    async sign(plan) {
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment }).send();
      const message = setTransactionMessageLifetimeUsingBlockhash(lifetime, payoutMessage(plan));
      return broadcastOf(await signTransactionMessageWithSigners(message), lifetime.lastValidBlockHeight);
    },
  };
}
