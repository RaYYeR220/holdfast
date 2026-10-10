import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import { getApproveCheckedInstruction, getRevokeInstruction } from '@solana-program/token';
import { associatedTokenAddress } from './accounts';
import { formatBaseUnits, MAX_TOKEN_AMOUNT } from './amounts';
import { connect, type RpcSource } from './connection';

export interface UnsignedTransaction<TSummary> {
  /** Base64 wire transaction with an empty signature slot for the owner. */
  transaction: string;
  summary: TSummary;
  /** The wallet has until this block height to get the transaction on chain. */
  lastValidBlockHeight: bigint;
}

export interface DelegateApprovalRequest extends RpcSource {
  /** The team's wallet. It signs and pays the fee. */
  owner: string;
  mint: string;
  decimals: number;
  /** Address of the service key. */
  delegate: string;
  /** Base units the delegate may move in total. */
  amount: bigint;
}

export interface DelegateApprovalSummary {
  owner: string;
  tokenAccount: string;
  mint: string;
  delegate: string;
  /** Decimal token amount, e.g. "10" or "2500.5". */
  amount: string;
}

export interface DelegateRevokeRequest extends RpcSource {
  owner: string;
  mint: string;
}

export interface DelegateRevokeSummary {
  owner: string;
  tokenAccount: string;
  mint: string;
}

async function unsignedOwnerTransaction(source: RpcSource, owner: Address, instruction: Instruction) {
  const { value: lifetime } = await connect(source).getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(owner, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstruction(instruction, m),
  );
  return {
    transaction: getBase64EncodedWireTransaction(compileTransaction(message)),
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  };
}

/**
 * The one transaction the team signs: it makes `delegate` the delegate of
 * the owner's token account for exactly `amount`.
 *
 * A token account has a single delegate and a single delegated amount.
 * Approving replaces both, so a new approval resets the allowance to
 * `amount` rather than adding to what is left, and it displaces any other
 * delegate the account had.
 */
export async function buildDelegateApproval(
  request: DelegateApprovalRequest,
): Promise<UnsignedTransaction<DelegateApprovalSummary>> {
  if (request.amount <= 0n || request.amount > MAX_TOKEN_AMOUNT) {
    throw new RangeError(`invalid approval amount ${request.amount}`);
  }
  const owner = address(request.owner);
  const mint = address(request.mint);
  const delegate = address(request.delegate);
  const tokenAccount = await associatedTokenAddress(owner, mint);
  const instruction = getApproveCheckedInstruction({
    source: tokenAccount,
    mint,
    delegate,
    owner: createNoopSigner(owner),
    amount: request.amount,
    decimals: request.decimals,
  });
  return {
    ...(await unsignedOwnerTransaction(request, owner, instruction)),
    summary: { owner, tokenAccount, mint, delegate, amount: formatBaseUnits(request.amount, request.decimals) },
  };
}

/** The transaction with which the team withdraws the delegation again. */
export async function buildDelegateRevoke(
  request: DelegateRevokeRequest,
): Promise<UnsignedTransaction<DelegateRevokeSummary>> {
  const owner = address(request.owner);
  const mint = address(request.mint);
  const tokenAccount = await associatedTokenAddress(owner, mint);
  const instruction = getRevokeInstruction({ source: tokenAccount, owner: createNoopSigner(owner) });
  return {
    ...(await unsignedOwnerTransaction(request, owner, instruction)),
    summary: { owner, tokenAccount, mint },
  };
}
