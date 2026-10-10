import type { PayoutLine } from '@holdfast/core';
import {
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
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
import { createSolanaPayoutRail, type SolanaPayoutRail } from '../src/rail';
import { accountInfo, addressOf, atSlot, fakeNode, tokenAccountInfo, type FakeNode } from './fake-node';

export const DELEGATE_SEED = new Uint8Array(32).fill(7);
export const OWNER: Address = addressOf(20);
export const MINT: Address = addressOf(21);
export const BLOCKHASH = blockhash(addressOf(22));
export const LATER_BLOCKHASH = blockhash(addressOf(23));
export const LAST_VALID_BLOCK_HEIGHT = 1_000;
export const TOKEN_ACCOUNT_RENT = 2_039_280;
export const WALLET_RENT = 890_880;

/** The slot at which the fake chain's confirmed block height is read. */
export const CHAIN_SLOT = 100;
/** The slot of the transaction that created the team's token account. */
export const CREATION_SLOT = 10;
/** The slot the first landed transaction of a test gets; later ones follow it. */
export const FIRST_LANDING_SLOT = 50;

export const payee = (line: number): Address => addressOf(30 + line);

type AccountInfo = ReturnType<typeof accountInfo>;
type RailOverrides = Partial<
  Pick<SolanaPayoutRailConfig, 'commitment' | 'maxNewTokenAccountsPerRun' | 'confirmTimeoutMs' | 'pollIntervalMs'>
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

export interface World {
  node: FakeNode;
  rail: SolanaPayoutRail;
  delegate: KeyPairSigner;
  /** The team's token account. */
  source: Address;
  /** What the fake node holds; tests add and replace accounts here. */
  accounts: Map<Address, AccountInfo>;
  /**
   * The transactions of the team's token account, newest first. It starts
   * with the one that created the account, as a complete history does.
   */
  history: HistoryItem[];
  /** Answers the fake node gives; tests overwrite what they need. */
  answers: {
    /** The status the node reports for a signature. */
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
    send: (wire: string, config: unknown) => string;
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
  /** Another rail on the same node and key, as after a restart of the service. */
  restart(overrides?: RailOverrides): SolanaPayoutRail;
  /** Put a transaction at the top of the history. */
  record(wire: string, entry?: Partial<HistoryEntry>, wallets?: Record<Address, Address>): HistoryItem;
  /** Make the history show a broadcast transaction as landed, paying `lines`. */
  land(wire: string, lines: readonly PayoutLine[], entry?: Partial<HistoryEntry>): Promise<HistoryItem>;
}

export const CONFIRMED = { slot: 5, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' };

export async function createWorld(overrides: RailOverrides = {}): Promise<World> {
  const delegate = await createKeyPairSignerFromPrivateKeyBytes(DELEGATE_SEED);
  const source = await associatedTokenAddress(OWNER, MINT);
  const accounts = new Map<Address, AccountInfo>();
  const sent: World['sent'] = [];

  const creation = await signedWire(delegate, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: delegate, ata: source, owner: OWNER, mint: MINT }),
  ]);
  const history: HistoryItem[] = [
    {
      entry: historyEntry(creation.signature, null, { slot: CREATION_SLOT }),
      transaction: recorded(creation.wire, { [source]: OWNER }, { created: [source], slot: CREATION_SLOT }),
    },
  ];

  const answers: World['answers'] = {
    status: () => CONFIRMED,
    blockhash: () => BLOCKHASH,
    statusSlot: () => CHAIN_SLOT,
    blockHeight: () => 10,
    finalizedSlot: () => CHAIN_SLOT - 32,
    firstAvailableBlock: () => 0,
    balance: () => 1_000_000_000,
    send: () => 'accepted',
    transaction: signature => history.find(item => item.entry.signature === signature)?.transaction ?? null,
    signatures: ({ before, limit = 1_000 }) => {
      const from = before ? history.findIndex(item => item.entry.signature === before) + 1 : 0;
      return history.slice(from, from + limit).map(item => item.entry);
    },
  };
  const node = fakeNode({
    getAccountInfo: ([address]) => atSlot(accounts.get(address as Address) ?? null),
    getMultipleAccounts: ([addresses]) => atSlot((addresses as Address[]).map(address => accounts.get(address) ?? null)),
    getLatestBlockhash: () =>
      atSlot({ blockhash: answers.blockhash(), lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }),
    getMinimumBalanceForRentExemption: ([size]) => (Number(size) === 0 ? WALLET_RENT : TOKEN_ACCOUNT_RENT),
    getBalance: () => atSlot(answers.balance()),
    getSlot: () => answers.finalizedSlot(),
    getFirstAvailableBlock: () => answers.firstAvailableBlock(),
    sendTransaction: ([wire, config]) => {
      sent.push({ wire: wire as string, config: config as { skipPreflight?: boolean } });
      return answers.send(wire as string, config);
    },
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

  const record: World['record'] = (wire, entry = {}, wallets = {}) => {
    const { signature, instructions } = decodeWire(wire);
    const memos = getMemosFromInstructions(instructions).map(({ memo }) => `[${memo.length}] ${memo}`);
    const slot = entry.slot ?? FIRST_LANDING_SLOT + history.length - 1;
    const item = {
      entry: historyEntry(signature, memos.length > 0 ? memos.join('; ') : null, { slot, ...entry }),
      transaction: recorded(wire, { [source]: OWNER, ...wallets }, { err: entry.err ?? null, slot }),
    };
    history.unshift(item);
    return item;
  };

  return {
    node,
    rail: restart(),
    delegate,
    source,
    accounts,
    history,
    answers,
    sent,
    restart,
    record,
    fund(fields) {
      accounts.set(source, tokenAccountInfo({ mint: MINT, owner: OWNER, ...fields }));
    },
    async openTokenAccount(wallet) {
      const tokenAccount = await associatedTokenAddress(wallet, MINT);
      accounts.set(tokenAccount, tokenAccountInfo({ mint: MINT, owner: wallet, amount: 0n }));
      return tokenAccount;
    },
    async land(wire, lines, entry = {}) {
      const wallets: Record<Address, Address> = {};
      for (const line of lines) wallets[await associatedTokenAddress(line.to, MINT)] = line.to as Address;
      return record(wire, entry, wallets);
    },
  };
}

/** The instructions of a wire transaction, as a node would read them. */
export function decodeWire(wire: string): {
  signature: string;
  instructions: ResolvedInstruction[];
  signers: Address[];
  accounts: Address[];
} {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  return {
    signature: getSignatureFromTransaction(transaction),
    instructions: getInstructionsFromCompiledTransactionMessage(message),
    signers: Object.entries(transaction.signatures).flatMap(([signer, signature]) =>
      signature ? [signer as Address] : [],
    ),
    accounts: 'staticAccounts' in message ? message.staticAccounts : [],
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
  const tokenAccounts = [...new Set([...movements.keys(), ...(Object.keys(wallets) as Address[])])].filter(account =>
    accounts.includes(account),
  );
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
