import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import { broadcastOf, type Broadcast, type FollowOptions } from './confirm';
import { connect, loadKeyPairSigner, type RpcSource, type SettledCommitment, type SolanaRpc } from './connection';
import { fetchRentRates, type RentRates } from './cost';
import type { RunIdentity } from './reconcile';
import { searchRun, type FoundRun, type KnownTransaction } from './search';

export interface SolanaPayoutRailConfig extends RpcSource {
  /** Mint of the token being paid out. */
  mint: string;
  decimals: number;
  /**
   * The service key, as bytes or base58. It is the delegate that moves the
   * tokens and the fee payer: it needs SOL for fees, for the run marker of
   * every run, and for the rent of any payee token account a run has to
   * create.
   */
  delegateSecretKey: Uint8Array | string;
  /** How settled chain state must be before the rail relies on it. Defaults to `confirmed`. */
  commitment?: SettledCommitment;
  /**
   * Addresses of service keys this rail used before the one it has now. A
   * run marker is derived from the key that paid, so after a rotation the
   * runs paid under the old key are only recognised if it is listed here.
   * The chain itself refuses a second payout only under the same key: for
   * these keys the rail looks before it sends, so an old key must stop
   * paying before the new one starts. Listing a key also takes its word:
   * whoever holds it can set the marker of a run that was never paid.
   */
  previousDelegates?: string[];
  /**
   * The most payee token accounts one run may create. The service key pays
   * the rent of each and the payee keeps it, so a run that names many fresh
   * addresses is a way to drain the key. Defaults to 3. Together with the
   * run marker and the fee this bounds what one run can cost the key:
   * this many token account rents, one marker rent, and 5,000 lamports.
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
  /** Service keys in use before the present one, whose run markers still count. */
  previousDelegates: readonly Address[];
  /** How a sent transaction is followed until it settles. */
  following: FollowOptions;
  /** The service key, loaded on first use. */
  delegate(): Promise<KeyPairSigner>;
  /**
   * Rent-exempt minimums as the node reports them. They are read again
   * every ten minutes: a cluster can change them, and a run marker funded at
   * a rate that has since gone up would fail for lack of rent.
   */
  rent(): Promise<RentRates>;
  /** Make a transaction of the instructions: the delegate pays the fee and signs, on a fresh blockhash. */
  sign(instructions: readonly Instruction[]): Promise<Broadcast>;
  /**
   * Look for a paid run in the history of a team token account. Null means
   * the chain proves there is none; whenever that cannot be established this
   * throws, as {@link searchRun} describes. `maxInspections` caps how many
   * transactions the search will fetch before it gives up.
   */
  findPaid(run: RunIdentity, notBefore?: bigint, maxInspections?: number): Promise<FoundRun | null>;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_MAX_NEW_TOKEN_ACCOUNTS = 3;
const REMEMBERED_TRANSACTIONS = 5_000;
const RENT_RATES_MAX_AGE_MS = 600_000;

export function createRailContext(config: SolanaPayoutRailConfig): RailContext {
  const maxNewTokenAccounts = config.maxNewTokenAccountsPerRun ?? DEFAULT_MAX_NEW_TOKEN_ACCOUNTS;
  if (!Number.isInteger(maxNewTokenAccounts) || maxNewTokenAccounts < 0) {
    throw new RangeError(`invalid maxNewTokenAccountsPerRun ${maxNewTokenAccounts}`);
  }
  const rpc = connect(config);
  const commitment = config.commitment ?? 'confirmed';
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let loadedKey: Promise<KeyPairSigner> | undefined;
  const delegate = (): Promise<KeyPairSigner> => (loadedKey ??= loadKeyPairSigner(config.delegateSecretKey));
  let rent: { rates: Promise<RentRates>; readAt: number } | undefined;
  /** Transactions of team accounts that searches have read, so that the next search does not fetch them again. */
  const known = new Map<string, KnownTransaction>();

  return {
    rpc,
    mint: address(config.mint),
    decimals: config.decimals,
    commitment,
    pollIntervalMs,
    maxNewTokenAccounts,
    previousDelegates: (config.previousDelegates ?? []).map(delegate => address(delegate)),
    following: {
      commitment,
      pollIntervalMs,
      ...(config.confirmTimeoutMs === undefined ? {} : { deadlineMs: config.confirmTimeoutMs }),
    },
    delegate,
    rent() {
      if (!rent || Date.now() - rent.readAt > RENT_RATES_MAX_AGE_MS) {
        const reading = { rates: fetchRentRates(rpc), readAt: Date.now() };
        // A failed fetch is not an answer worth keeping.
        reading.rates.catch(() => {
          if (rent === reading) rent = undefined;
        });
        rent = reading;
      }
      return rent.rates;
    },
    async sign(instructions) {
      const feePayer = await delegate();
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(feePayer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        m => appendTransactionMessageInstructions(instructions, m),
      );
      return broadcastOf(await signTransactionMessageWithSigners(message), lifetime.lastValidBlockHeight);
    },
    async findPaid(run, notBefore, maxInspections) {
      try {
        return await searchRun(rpc, run, {
          commitment,
          known,
          ...(notBefore === undefined ? {} : { notBefore }),
          ...(maxInspections === undefined ? {} : { maxInspections }),
        });
      } finally {
        for (const oldest of known.keys()) {
          if (known.size <= REMEMBERED_TRANSACTIONS) break;
          known.delete(oldest);
        }
      }
    },
  };
}
