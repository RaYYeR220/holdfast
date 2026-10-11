import assert from 'node:assert/strict';
import {
  getBase64Encoder,
  MAX_SUPPORTED_TRANSACTION_VERSION,
  signature as toSignature,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { sleep } from '../src/confirm';
import type { SolanaRpc } from '../src/connection';
import type { RpcSource, SolanaPayoutRail, SolanaPayoutRailConfig } from '../src/index';
import type { RefusedOnChain } from './chain';

export interface ProofStep {
  title: string;
  signature: string | null;
  notes: string[];
}

/** What every part of the proof works with. */
export interface Proving {
  rpc: SolanaRpc;
  /** The node all of it talks to. */
  node: RpcSource;
  railConfig: SolanaPayoutRailConfig;
  rail: SolanaPayoutRail;
  /** The team wallet. In the steps about markers it also stands in for anybody who is not the service key. */
  owner: KeyPairSigner;
  delegate: KeyPairSigner;
  mint: Address;
  payees: readonly [Address, Address, Address];
  /** An address that never gets a token account. */
  newcomer: Address;
  amount(decimal: string): bigint;
  show(units: bigint): string;
  /** remaining() for the owner, polled until it reads `expected`. */
  remaining(expected: bigint): Promise<bigint>;
  step(title: string, signature: string | null, notes?: string[]): void;
  /** Record a transaction that was sent to be refused, with what the chain says about it. */
  refusedStep(title: string, refusal: RefusedOnChain): Promise<void>;
}

/**
 * Poll a read until it shows what the last transaction should have caused.
 * The nodes behind a public endpoint lag one another by a slot or two.
 */
export async function eventually<T>(read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 15 && !settled(value); attempt++) {
    await sleep(1_500);
    value = await read();
  }
  return value;
}

export interface Landed {
  /** Facts about the transaction, quoted from the node rather than from our own bookkeeping. */
  notes: string[];
  /** Lamports that left the fee payer, fee included. */
  spent: bigint;
}

const NOTABLE_LOG = /failed|error|already in use|must not carry/i;

export async function readLanded(rpc: SolanaRpc, signature: string): Promise<Landed> {
  const response = await eventually(
    () =>
      rpc
        .getTransaction(toSignature(signature), {
          commitment: 'confirmed',
          encoding: 'base64',
          maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        })
        .send(),
    found => found !== null,
  );
  assert.ok(response?.meta, `the node did not return transaction ${signature}`);
  const { meta } = response;
  const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item));
  const notes = [
    `slot ${response.slot}, meta.err: \`${json(meta.err)}\``,
    `${getBase64Encoder().encode(response.transaction[0]).length} bytes, fee ${meta.fee} lamports, ` +
      `${meta.computeUnitsConsumed ?? 'unknown'} compute units`,
  ];
  if (meta.err !== null) {
    const failures = (meta.logMessages ?? []).filter(line => NOTABLE_LOG.test(line));
    notes.push(...failures.map(line => `log: \`${line}\``));
  }
  const [before, after] = [meta.preBalances[0], meta.postBalances[0]];
  assert.ok(before !== undefined && after !== undefined);
  return { notes, spent: BigInt(before) - BigInt(after) };
}
