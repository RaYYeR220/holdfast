import type { PayoutLine } from '@holdfast/core';
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAccountMetasFromCompiledTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
  isSignerRole,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ResolvedInstruction,
} from '@solana/kit';
import { getMemosFromInstructions } from '@solana-program/memo';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TRANSFER_CHECKED_DISCRIMINATOR,
  TRANSFER_DISCRIMINATOR,
} from '@solana-program/token';
import { associatedTokenAddress } from '../src/accounts';
import type { SolanaPayoutRailConfig } from '../src/context';
import { runMarker, runMarkerSeed } from '../src/marker';
import type { PayoutPlan } from '../src/payout';
import { createSolanaPayoutRail, type SolanaPayoutRail } from '../src/rail';
import { accountInfo, addressOf, atSlot, fakeNode, NodeError, tokenAccountInfo, type FakeNode } from './fake-node';
import { executeSystemInstructions, rentFor, type Execution, type LedgerAccount } from './ledger';

export const DELEGATE_SEED = new Uint8Array(32).fill(7);
export const OWNER: Address = addressOf(20);
export const MINT: Address = addressOf(21);
export const BLOCKHASH = blockhash(addressOf(22));
export const LATER_BLOCKHASH = blockhash(addressOf(23));
export const LAST_VALID_BLOCK_HEIGHT = 1_000;
export const TOKEN_ACCOUNT_RENT = Number(rentFor(165));
export const MARKER_RENT = Number(rentFor(1));
export const WALLET_RENT = Number(rentFor(0));

/** The slot at which the fake chain's confirmed block height is read. */
export const CHAIN_SLOT = 100;
/** The slot of the transaction that created the team's token account. */
export const CREATION_SLOT = 10;
/** The slot the first landed transaction of a test gets; later ones follow it. */
export const FIRST_LANDING_SLOT = 50;

export const payee = (line: number): Address => addressOf(30 + line);
const KNOWN_PAYEES = 40;

type AccountInfo = ReturnType<typeof accountInfo>;
type RailOverrides = Partial<
  Pick<
    SolanaPayoutRailConfig,
    | 'commitment'
    | 'maxNewTokenAccountsPerRun'
    | 'confirmTimeoutMs'
    | 'pollIntervalMs'
    | 'delegateSecretKey'
    | 'previousDelegates'
    | 'markersFrom'
  >
>;

export interface HistoryEntry {
  signature: string;
  memo: string | null;
  err: unknown;
  slot: number;
  blockTime: number;
  confirmationStatus: string | null;
}

/** One transaction of the team's token account: how the node lists it and what it returns for it. */
export interface HistoryItem {
  entry: HistoryEntry;
  transaction: unknown;
}

/**
 * A fake chain behind a fake node. It executes the System program
 * instructions of every transaction it is sent by the rules in ledger.ts,
 * lets the transaction land, and lists it in the history of the team's token
 * account. The Token program is not executed: token accounts hold what a
 * test puts there with `fund`.
 */
export interface World {
  node: FakeNode;
  rail: SolanaPayoutRail;
  delegate: KeyPairSigner;
  /** The team's token account. */
  source: Address;
  /** What the fake chain holds; tests add and replace accounts here. */
  accounts: Map<Address, AccountInfo>;
  /**
   * The transactions of the team's token account, newest first. It starts
   * with the one that created the account, as a complete history does.
   */
  history: HistoryItem[];
  /** How each transaction that reached the chain ended. */
  landed: Map<string, { err: unknown }>;
  /** Answers the fake node gives; tests overwrite what they need. */
  answers: {
    /** The status the node reports for a signature. Defaults to how the transaction landed, if it did. */
    status: (signature: string) => unknown;
    blockhash: () => string;
    /** The slot the node that answers a status query has processed. */
    statusSlot: () => number;
    blockHeight: () => number;
    /** The slot the chain has finalized. */
    finalizedSlot: () => number;
    /** The lowest slot the node still has history for. */
    firstAvailableBlock: () => number;
    /** Lamports held by the service key. */
    balance: () => number;
    /**
     * What the node shows of an account when it is asked, given what the
     * chain holds. A node may be behind, or be asked at a commitment the
     * account has not reached; what a sent transaction meets is the chain.
     */
    account: (address: Address, held: AccountInfo | null) => AccountInfo | null;
    /** Runs before the node looks at a sent transaction; throws to refuse it. */
    send: (wire: string, config: unknown) => void;
    /** Whether a sent transaction is lost on its way and never lands. */
    drops: (signature: string) => boolean;
    /** An error a transaction meets when it lands although its simulation passed, as when a token account changed in between. */
    failsOnChain: (signature: string) => unknown;
    /** Whether preflight sees a chain that is behind and so lets through what will fail when it lands. */
    stalePreflight: () => boolean;
    /** Defaults to what `history` holds. */
    transaction: (signature: string) => unknown;
    /** Defaults to pages of `history`. */
    signatures: (config: { before?: string; limit?: number }) => unknown[];
  };
  /** Wire transactions the rail asked the node to broadcast. */
  sent: { wire: string; config: { skipPreflight?: boolean } }[];
  /** Give the team's token account a balance and, optionally, a delegation. */
  fund(fields: { amount: bigint; delegate?: Address; delegatedAmount?: bigint; frozen?: boolean }): void;
  /** Give a payee an existing token account. */
  openTokenAccount(wallet: Address): Promise<Address>;
  /** Another rail on the same chain, as after a restart of the service. */
  restart(overrides?: RailOverrides): SolanaPayoutRail;
  /** The run marker of a run of the team wallet under a service key, by default the one in use. */
  markerOf(runId: string, delegate?: Address): Promise<Address>;
  /** Whether a run marker is set on the fake chain. */
  isMarked(runId: string, delegate?: Address): Promise<boolean>;
  /** The payout a rail plans for `lines` when no payee has a token account yet and nobody funded the marker. */
  planFor(lines: readonly PayoutLine[], options?: { runId?: string; lineMemos?: boolean }): Promise<PayoutPlan>;
  /**
   * Let a transaction that the rail did not send land on the chain: it is
   * executed like any other and listed in the history. `entry.err` makes it
   * fail; the other fields change how the node lists it.
   */
  record(wire: string, entry?: Partial<HistoryEntry>): Promise<HistoryItem>;
}

export const CONFIRMED = { slot: 5, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' };

export async function createWorld(overrides: RailOverrides = {}): Promise<World> {
  const delegate = await createKeyPairSignerFromPrivateKeyBytes(DELEGATE_SEED);
  const source = await associatedTokenAddress(OWNER, MINT);
  const accounts = new Map<Address, AccountInfo>();
  const landed: World['landed'] = new Map();
  const sent: World['sent'] = [];

  /** Which wallet owns which token account, for the balance records of a transaction. */
  const walletOf: Record<Address, Address> = { [source]: OWNER };
  for (let line = 0; line < KNOWN_PAYEES; line++) walletOf[await associatedTokenAddress(payee(line), MINT)] = payee(line);

  const creation = await signedWire(delegate, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: delegate, ata: source, owner: OWNER, mint: MINT }),
  ]);
  const history: HistoryItem[] = [
    {
      entry: historyEntry(creation.signature, null, { slot: CREATION_SLOT }),
      transaction: recorded(creation.wire, walletOf, { created: [source], slot: CREATION_SLOT }),
    },
  ];

  const answers: World['answers'] = {
    status: signature => {
      const outcome = landed.get(signature);
      return outcome ? { ...CONFIRMED, err: outcome.err } : null;
    },
    blockhash: () => BLOCKHASH,
    statusSlot: () => CHAIN_SLOT,
    blockHeight: () => 10,
    finalizedSlot: () => CHAIN_SLOT - 32,
    firstAvailableBlock: () => 0,
    balance: () => 1_000_000_000,
    account: (_address, held) => held,
    send: () => undefined,
    drops: () => false,
    failsOnChain: () => null,
    stalePreflight: () => false,
    transaction: signature => history.find(item => item.entry.signature === signature)?.transaction ?? null,
    signatures: ({ before, limit = 1_000 }) => {
      const from = before ? history.findIndex(item => item.entry.signature === before) + 1 : 0;
      return history.slice(from, from + limit).map(item => item.entry);
    },
  };

  const read = (address: Address): LedgerAccount | undefined => {
    if (address === delegate.address) return { lamports: BigInt(answers.balance()), owner: SYSTEM_PROGRAM_ADDRESS, space: 0 };
    const account = accounts.get(address);
    return account && { lamports: BigInt(account.lamports), owner: account.owner, space: account.space };
  };
  const execute = (wire: string): Promise<Execution> => {
    const { instructions, accounts: keys } = decodeWire(wire);
    return executeSystemInstructions(instructions, keys, read);
  };
  /** The chain takes one transaction at a time: what a transaction meets is what the one before it left. */
  let lastInLine: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lastInLine.then(work);
    lastInLine = result.catch(() => undefined);
    return result;
  };

  /** Let a transaction land: apply what it did if it succeeded, and list it if it touched the team's account. */
  function land(wire: string, execution: Execution, entry: Partial<HistoryEntry> = {}): HistoryItem | null {
    const { signature, instructions, accounts: keys } = decodeWire(wire);
    const err = entry.err ?? answers.failsOnChain(signature) ?? execution.err;
    landed.set(signature, { err });
    if (err === null && execution.err === null) {
      for (const [address, account] of execution.accounts) {
        // The service key's lamports are whatever a test says they are.
        if (address === delegate.address) continue;
        const before = accounts.get(address);
        const lamports = Number(account.lamports);
        if (lamports === 0) accounts.delete(address);
        else if (before && before.space === account.space) accounts.set(address, { ...before, lamports });
        else accounts.set(address, accountInfo(account.owner, new Uint8Array(account.space), lamports));
      }
    }
    if (!keys.includes(source)) return null;
    const memos = getMemosFromInstructions(instructions).map(({ memo }) => `[${memo.length}] ${memo}`);
    const slot = entry.slot ?? FIRST_LANDING_SLOT + history.length - 1;
    const item = {
      entry: historyEntry(signature, memos.length > 0 ? memos.join('; ') : null, { slot, ...entry, err }),
      transaction: recorded(wire, walletOf, { err, slot }),
    };
    history.unshift(item);
    return item;
  }

  const shown = (address: Address): AccountInfo | null => answers.account(address, accounts.get(address) ?? null);
  const node = fakeNode({
    getAccountInfo: ([address]) => atSlot(shown(address as Address)),
    getMultipleAccounts: ([addresses]) => atSlot((addresses as Address[]).map(shown)),
    getLatestBlockhash: () =>
      atSlot({ blockhash: answers.blockhash(), lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }),
    getMinimumBalanceForRentExemption: ([size]) => Number(rentFor(Number(size))),
    getBalance: () => atSlot(answers.balance()),
    getSlot: () => answers.finalizedSlot(),
    getFirstAvailableBlock: () => answers.firstAvailableBlock(),
    sendTransaction: ([wire, config]) =>
      inTurn(async () => {
        const options = config as { skipPreflight?: boolean };
        sent.push({ wire: wire as string, config: options });
        answers.send(wire as string, config);
        const { signature } = decodeWire(wire as string);
        if (landed.has(signature)) return signature;
        const execution = await execute(wire as string);
        if (execution.err !== null && !options.skipPreflight && !answers.stalePreflight()) {
          throw new NodeError(-32002, 'Transaction simulation failed', { err: execution.err, logs: [] });
        }
        if (!answers.drops(signature)) land(wire as string, execution);
        return signature;
      }),
    getSignatureStatuses: ([signatures]) => ({
      context: { slot: answers.statusSlot() },
      value: [answers.status((signatures as string[])[0] ?? '')],
    }),
    getEpochInfo: () => ({
      absoluteSlot: CHAIN_SLOT,
      blockHeight: answers.blockHeight(),
      epoch: 1,
      slotIndex: CHAIN_SLOT,
      slotsInEpoch: 432_000,
      transactionCount: 1,
    }),
    getTransaction: ([signature]) => answers.transaction(signature as string),
    getSignaturesForAddress: ([, config]) => answers.signatures(config as { before?: string; limit?: number }),
  });
  const restart = (again: RailOverrides = {}): SolanaPayoutRail =>
    createSolanaPayoutRail({
      rpcUrl: 'http://fake',
      transport: node.transport,
      mint: MINT,
      decimals: 6,
      delegateSecretKey: DELEGATE_SEED,
      pollIntervalMs: 0,
      ...overrides,
      ...again,
    });
  const markerOf: World['markerOf'] = async (runId, key = delegate.address) =>
    (await runMarker(key, await runMarkerSeed(OWNER, MINT, runId))).address;
  const planFor: World['planFor'] = async (lines, { runId = 'HF-2026-10-0001', lineMemos = true } = {}) => ({
    delegate,
    source,
    mint: MINT,
    decimals: 6,
    runId,
    marker: await runMarker(delegate.address, await runMarkerSeed(OWNER, MINT, runId)),
    markerLamports: BigInt(MARKER_RENT),
    lineMemos,
    transfers: await Promise.all(
      lines.map(async line => ({
        payee: address(line.to),
        tokenAccount: await associatedTokenAddress(line.to, MINT),
        amount: line.amount,
        memo: line.memo,
        createTokenAccount: true,
      })),
    ),
  });

  return {
    node,
    rail: restart(),
    delegate,
    source,
    accounts,
    history,
    landed,
    answers,
    sent,
    restart,
    markerOf,
    planFor,
    async isMarked(runId, key) {
      const account = accounts.get(await markerOf(runId, key));
      return account !== undefined && account.owner === SYSTEM_PROGRAM_ADDRESS && account.space > 0;
    },
    record: (wire, entry = {}) =>
      inTurn(async () => {
        const item = land(wire, await execute(wire), entry);
        if (!item) throw new Error('the transaction does not touch the team token account');
        return item;
      }),
    fund(fields) {
      accounts.set(source, tokenAccountInfo({ mint: MINT, owner: OWNER, ...fields }));
    },
    async openTokenAccount(wallet) {
      const tokenAccount = await associatedTokenAddress(wallet, MINT);
      walletOf[tokenAccount] = wallet;
      accounts.set(tokenAccount, tokenAccountInfo({ mint: MINT, owner: wallet, amount: 0n }));
      return tokenAccount;
    },
  };
}

/** A wire transaction as a node would read it. */
export function decodeWire(wire: string): {
  signature: string;
  instructions: ResolvedInstruction[];
  /** The addresses whose signature the message asks for. */
  signers: Address[];
  /** The addresses that did sign. */
  signed: Address[];
  accounts: Address[];
} {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const metas = getAccountMetasFromCompiledTransactionMessage(message);
  return {
    signature: getSignatureFromTransaction(transaction),
    instructions: getInstructionsFromCompiledTransactionMessage(message),
    signers: metas.filter(meta => isSignerRole(meta.role)).map(meta => meta.address),
    signed: Object.entries(transaction.signatures).flatMap(([signer, signature]) =>
      signature ? [signer as Address] : [],
    ),
    accounts: metas.map(meta => meta.address),
  };
}

/** Sign instructions into a transaction that looks like one read back from the chain. */
export async function signedWire(feePayer: KeyPairSigner, instructions: readonly Instruction[]) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(feePayer, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000n }, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  return { wire: getBase64EncodedWireTransaction(transaction), signature: getSignatureFromTransaction(transaction) };
}

/** An entry of a `getSignaturesForAddress` answer. */
export function historyEntry(signature: string, memo: string | null, entry: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    signature,
    memo,
    err: null,
    slot: FIRST_LANDING_SLOT,
    blockTime: 1_791_637_091,
    confirmationStatus: 'finalized',
    ...entry,
  };
}

/** Token transfers in a transaction's instructions, as debits and credits per token account. */
function tokenMovements(instructions: readonly ResolvedInstruction[]): Map<Address, bigint> {
  const net = new Map<Address, bigint>();
  const move = (from: Address, to: Address, amount: bigint): void => {
    net.set(from, (net.get(from) ?? 0n) - amount);
    net.set(to, (net.get(to) ?? 0n) + amount);
  };
  for (const instruction of instructions) {
    if (instruction.programAddress !== TOKEN_PROGRAM_ADDRESS) continue;
    if (!isInstructionWithAccounts(instruction) || !isInstructionWithData(instruction)) continue;
    if (instruction.data[0] === TRANSFER_CHECKED_DISCRIMINATOR) {
      const { accounts, data } = parseTransferCheckedInstruction(instruction);
      move(accounts.source.address, accounts.destination.address, data.amount);
    } else if (instruction.data[0] === TRANSFER_DISCRIMINATOR) {
      const { accounts, data } = parseTransferInstruction(instruction);
      move(accounts.source.address, accounts.destination.address, data.amount);
    }
  }
  return net;
}

/**
 * A `getTransaction` answer for a wire transaction, with the lamport and
 * token balance records a node attaches. `wallets` maps token accounts to
 * the wallets that own them; `created` lists accounts that did not exist
 * before the transaction.
 */
export function recorded(
  wire: string,
  wallets: Record<Address, Address>,
  options: { err?: unknown; created?: readonly Address[]; slot?: number } = {},
) {
  const { accounts, instructions } = decodeWire(wire);
  const err = options.err ?? null;
  const movements = tokenMovements(instructions);
  const tokenAccounts = accounts.filter(account => movements.has(account) || wallets[account] !== undefined);
  const startingBalance = 1_000_000_000n;
  const balances = (settled: boolean) =>
    tokenAccounts.map(tokenAccount => {
      const amount = startingBalance + (settled && err === null ? (movements.get(tokenAccount) ?? 0n) : 0n);
      return {
        accountIndex: accounts.indexOf(tokenAccount),
        mint: MINT,
        ...(wallets[tokenAccount] ? { owner: wallets[tokenAccount] } : {}),
        uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmountString: '0' },
      };
    });
  return {
    slot: options.slot ?? FIRST_LANDING_SLOT,
    blockTime: 1_791_637_091,
    version: 0,
    transaction: [wire, 'base64'],
    meta: {
      err,
      fee: 5_000,
      preBalances: accounts.map(account => (options.created?.includes(account) ? 0 : 1_000_000)),
      postBalances: accounts.map(() => 1_000_000),
      preTokenBalances: balances(false),
      postTokenBalances: balances(true),
    },
  };
}
