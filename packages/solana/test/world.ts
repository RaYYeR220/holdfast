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
import { associatedTokenAddress } from '../src/accounts';
import { createSolanaPayoutRail, type SolanaPayoutRail } from '../src/rail';
import { accountInfo, addressOf, atSlot, fakeNode, tokenAccountInfo, type FakeNode } from './fake-node';

export const DELEGATE_SEED = new Uint8Array(32).fill(7);
export const OWNER: Address = addressOf(20);
export const MINT: Address = addressOf(21);
export const BLOCKHASH = blockhash(addressOf(22));
export const LAST_VALID_BLOCK_HEIGHT = 1_000;

export const payee = (line: number): Address => addressOf(30 + line);

type AccountInfo = ReturnType<typeof accountInfo>;

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
    status: () => unknown;
    blockHeight: () => number;
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
}

export const CONFIRMED = { slot: 5, confirmations: 1, err: null, status: { Ok: null }, confirmationStatus: 'confirmed' };

export async function createWorld(): Promise<World> {
  const delegate = await createKeyPairSignerFromPrivateKeyBytes(DELEGATE_SEED);
  const source = await associatedTokenAddress(OWNER, MINT);
  const accounts = new Map<Address, AccountInfo>();
  const sent: World['sent'] = [];
  const answers: World['answers'] = {
    status: () => CONFIRMED,
    blockHeight: () => 10,
    send: () => 'accepted',
    transaction: () => null,
    signatures: () => [],
  };
  const node = fakeNode({
    getAccountInfo: ([address]) => atSlot(accounts.get(address as Address) ?? null),
    getMultipleAccounts: ([addresses]) => atSlot((addresses as Address[]).map(address => accounts.get(address) ?? null)),
    getLatestBlockhash: () => atSlot({ blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }),
    sendTransaction: ([wire, config]) => {
      sent.push({ wire: wire as string, config: config as { skipPreflight?: boolean } });
      return answers.send(wire as string, config);
    },
    getSignatureStatuses: () => atSlot([answers.status()]),
    getBlockHeight: () => answers.blockHeight(),
    getTransaction: ([signature]) => answers.transaction(signature as string),
    getSignaturesForAddress: ([, config]) => answers.signatures(config as { before?: string }),
  });
  const rail = createSolanaPayoutRail({
    rpcUrl: 'http://fake',
    transport: node.transport,
    mint: MINT,
    decimals: 6,
    delegateSecretKey: DELEGATE_SEED,
    pollIntervalMs: 0,
  });
  return {
    node,
    rail,
    delegate,
    source,
    accounts,
    answers,
    sent,
    fund(fields) {
      accounts.set(source, tokenAccountInfo({ mint: MINT, owner: OWNER, ...fields }));
    },
    async openTokenAccount(wallet) {
      const tokenAccount = await associatedTokenAddress(wallet, MINT);
      accounts.set(tokenAccount, tokenAccountInfo({ mint: MINT, owner: wallet, amount: 0n }));
      return tokenAccount;
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
