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

export const payee = (line: number): Address => addressOf(30 + line);

type AccountInfo = ReturnType<typeof accountInfo>;
type RailOverrides = Partial<
  Pick<SolanaPayoutRailConfig, 'maxNewTokenAccountsPerRun' | 'confirmTimeoutMs' | 'pollIntervalMs'>
>;

export interface World {
  node: FakeNode;
  rail: SolanaPayoutRail;
  delegate: KeyPairSigner;
  /** The team's token account. */
  source: Address;
  /** What the fake node holds; tests add and replace accounts here. */
  accounts: Map<Address, AccountInfo>;
  /** Answers the fake node gives; tests overwrite what they need. */
  answers: {
    /** The status the node reports for a signature. */
    status: (signature: string) => unknown;
    blockhash: () => string;
    /** The slot the node that answers a status query has processed. */
    statusSlot: () => number;
    blockHeight: () => number;
    /** Lamports held by the service key. */
    balance: () => number;
    send: (wire: string, config: unknown) => string;
    transaction: (signature: string) => unknown;
    signatures: (config: { before?: string }) => unknown[];
  };
  /** Wire transactions the rail asked the node to broadcast. */
  sent: { wire: string; config: { skipPreflight?: boolean } }[];
  /** Give the team's token account a balance and, optionally, a delegation. */
  fund(fields: { amount: bigint; delegate?: Address; delegatedAmount?: bigint; frozen?: boolean }): void;
  /** Give a payee an existing token account. */
  openTokenAccount(wallet: Address): Promise<Address>;
  /** Another rail on the same node and key, as after a restart of the service. */
  restart(overrides?: RailOverrides): SolanaPayoutRail;
  /** Make the node's history show a broadcast transaction as landed, paying `lines`. */
  land(wire: string, lines: readonly PayoutLine[]): Promise<void>;
}

export const CONFIRMED = { slot: 5, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' };

/** The slot at which the fake chain's confirmed block height is read. */
export const CHAIN_SLOT = 100;

export async function createWorld(overrides: RailOverrides = {}): Promise<World> {
  const delegate = await createKeyPairSignerFromPrivateKeyBytes(DELEGATE_SEED);
  const source = await associatedTokenAddress(OWNER, MINT);
  const accounts = new Map<Address, AccountInfo>();
  const sent: World['sent'] = [];
  const answers: World['answers'] = {
    status: () => CONFIRMED,
    blockhash: () => BLOCKHASH,
    statusSlot: () => CHAIN_SLOT,
    blockHeight: () => 10,
    balance: () => 1_000_000_000,
    send: () => 'accepted',
    transaction: () => null,
    signatures: () => [],
  };
  const node = fakeNode({
    getAccountInfo: ([address]) => atSlot(accounts.get(address as Address) ?? null),
    getMultipleAccounts: ([addresses]) => atSlot((addresses as Address[]).map(address => accounts.get(address) ?? null)),
    getLatestBlockhash: () =>
      atSlot({ blockhash: answers.blockhash(), lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }),
    getMinimumBalanceForRentExemption: ([size]) => (Number(size) === 0 ? WALLET_RENT : TOKEN_ACCOUNT_RENT),
    getBalance: () => atSlot(answers.balance()),
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
    getSignaturesForAddress: ([, config]) => answers.signatures(config as { before?: string }),
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
  return {
    node,
    rail: restart(),
    delegate,
    source,
    accounts,
    answers,
    sent,
    restart,
    fund(fields) {
      accounts.set(source, tokenAccountInfo({ mint: MINT, owner: OWNER, ...fields }));
    },
    async openTokenAccount(wallet) {
      const tokenAccount = await associatedTokenAddress(wallet, MINT);
      accounts.set(tokenAccount, tokenAccountInfo({ mint: MINT, owner: wallet, amount: 0n }));
      return tokenAccount;
    },
    async land(wire, lines) {
      const wallets: Record<Address, Address> = {};
      for (const line of lines) wallets[await associatedTokenAddress(line.to, MINT)] = line.to as Address;
      const { signature, instructions } = decodeWire(wire);
      const memos = getMemosFromInstructions(instructions).map(({ memo }) => `[${memo.length}] ${memo}`);
      answers.signatures = () => [historyEntry(signature, memos.join('; '))];
      answers.transaction = () => recorded(wire, wallets);
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
export const historyEntry = (signature: string, memo: string | null, err: unknown = null) => ({
  signature,
  memo,
  err,
  slot: 77,
  blockTime: 1_791_637_091,
  confirmationStatus: 'finalized',
});

/**
 * A `getTransaction` answer for a wire transaction, with the token balance
 * records a node attaches. `wallets` maps each credited token account to the
 * wallet that owns it.
 */
export function recorded(wire: string, wallets: Record<Address, Address>, err: unknown = null) {
  const { accounts } = decodeWire(wire);
  return {
    slot: 77,
    blockTime: 1_791_637_091,
    version: 0,
    transaction: [wire, 'base64'],
    meta: {
      err,
      fee: 5_000,
      postTokenBalances: Object.entries(wallets).map(([tokenAccount, owner]) => ({
        accountIndex: accounts.indexOf(tokenAccount as Address),
        mint: MINT,
        owner,
        uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' },
      })),
    },
  };
}
