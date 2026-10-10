import {
  AccountRole,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getInstructionsFromCompiledTransactionMessage,
  getTransactionDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
} from '@solana/kit';
import {
  identifyTokenInstruction,
  parseApproveCheckedInstruction,
  parseRevokeInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
} from '@solana-program/token';
import { describe, expect, it } from 'vitest';
import { associatedTokenAddress } from '../src/accounts';
import { buildDelegateApproval, buildDelegateRevoke } from '../src/approval';
import { addressOf, atSlot, fakeNode } from './fake-node';

const OWNER = addressOf(10);
const MINT = addressOf(11);
const DELEGATE = addressOf(12);
const BLOCKHASH = addressOf(13);

const node = () =>
  fakeNode({ getLatestBlockhash: () => atSlot({ blockhash: BLOCKHASH, lastValidBlockHeight: 4_242 }) });

/** Decode the wire transaction the way a wallet would before signing it. */
function decode(base64: string) {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  const instructions = getInstructionsFromCompiledTransactionMessage(message).map(instruction => {
    if (!isInstructionWithAccounts(instruction) || !isInstructionWithData(instruction)) {
      throw new Error('expected an instruction with accounts and data');
    }
    return instruction;
  });
  return { transaction, message, instructions };
}

describe('buildDelegateApproval', () => {
  const request = {
    rpcUrl: 'http://fake',
    owner: OWNER,
    mint: MINT,
    decimals: 6,
    delegate: DELEGATE,
    amount: 10_000_000n,
  };

  it('contains exactly one approveChecked, with the right accounts and amount', async () => {
    const built = await buildDelegateApproval({ ...request, transport: node().transport });
    const { instructions } = decode(built.transaction);
    expect(instructions).toHaveLength(1);
    const [instruction] = instructions;
    if (!instruction) throw new Error('unreachable');
    expect(instruction.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(identifyTokenInstruction(instruction)).toBe(TokenInstruction.ApproveChecked);

    const { accounts, data } = parseApproveCheckedInstruction(instruction);
    expect(instruction.accounts).toHaveLength(4);
    expect(accounts.source).toEqual({
      address: await associatedTokenAddress(OWNER, MINT),
      role: AccountRole.WRITABLE,
    });
    expect(accounts.mint).toEqual({ address: MINT, role: AccountRole.READONLY });
    expect(accounts.delegate).toEqual({ address: DELEGATE, role: AccountRole.READONLY });
    expect(accounts.owner).toEqual({ address: OWNER, role: AccountRole.WRITABLE_SIGNER });
    expect(data.amount).toBe(10_000_000n);
    expect(data.decimals).toBe(6);
  });

  it('is an unsigned v0 transaction with the owner as fee payer and only signer', async () => {
    const built = await buildDelegateApproval({ ...request, transport: node().transport });
    const { transaction, message } = decode(built.transaction);
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(OWNER);
    expect(message.header.numSignerAccounts).toBe(1);
    expect(message.lifetimeToken).toBe(BLOCKHASH);
    expect(transaction.signatures).toEqual({ [OWNER]: null });
    expect(built.lastValidBlockHeight).toBe(4_242n);
  });

  it('summarises what the owner is about to sign', async () => {
    const built = await buildDelegateApproval({ ...request, transport: node().transport });
    expect(built.summary).toEqual({
      owner: OWNER,
      tokenAccount: await associatedTokenAddress(OWNER, MINT),
      mint: MINT,
      delegate: DELEGATE,
      amount: '10',
    });
  });

  it('refuses an amount that is not a positive token amount', async () => {
    const { transport } = node();
    await expect(buildDelegateApproval({ ...request, transport, amount: 0n })).rejects.toThrow(/invalid approval amount/);
    await expect(buildDelegateApproval({ ...request, transport, amount: -1n })).rejects.toThrow(/invalid approval amount/);
    await expect(buildDelegateApproval({ ...request, transport, amount: 2n ** 64n })).rejects.toThrow(
      /invalid approval amount/,
    );
  });

  it('refuses malformed addresses before talking to the node', async () => {
    const fake = node();
    await expect(buildDelegateApproval({ ...request, transport: fake.transport, delegate: 'nope' })).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });
});

describe('buildDelegateRevoke', () => {
  it('contains exactly one revoke on the owner token account, signed by the owner', async () => {
    const { transport } = node();
    const built = await buildDelegateRevoke({ rpcUrl: 'http://fake', transport, owner: OWNER, mint: MINT });
    const { transaction, message, instructions } = decode(built.transaction);
    expect(instructions).toHaveLength(1);
    const [instruction] = instructions;
    if (!instruction) throw new Error('unreachable');
    expect(instruction.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(identifyTokenInstruction(instruction)).toBe(TokenInstruction.Revoke);

    const tokenAccount = await associatedTokenAddress(OWNER, MINT);
    const { accounts } = parseRevokeInstruction(instruction);
    expect(instruction.accounts).toHaveLength(2);
    expect(accounts.source).toEqual({ address: tokenAccount, role: AccountRole.WRITABLE });
    expect(accounts.owner).toEqual({ address: OWNER, role: AccountRole.WRITABLE_SIGNER });
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(OWNER);
    expect(transaction.signatures).toEqual({ [OWNER]: null });
    expect(built.summary).toEqual({ owner: OWNER, tokenAccount, mint: MINT });
    expect(built.lastValidBlockHeight).toBe(4_242n);
  });
});
