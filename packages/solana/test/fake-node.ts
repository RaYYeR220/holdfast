import {
  getAddressDecoder,
  getBase64Decoder,
  none,
  some,
  type Address,
  type RpcTransport,
} from '@solana/kit';
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

type Handler = (params: readonly unknown[]) => unknown | Promise<unknown>;

/** Thrown by a handler to make the fake node answer with a JSON-RPC error. */
export class NodeError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface FakeNode {
  transport: RpcTransport;
  /** Every request the code under test made, in order. */
  calls: { method: string; params: readonly unknown[] }[];
  methods(): string[];
  /** Methods that fail at the transport, as when the node cannot be reached. */
  unreachable: Set<string>;
}

/**
 * A stand-in for an RPC node: each JSON-RPC method is answered by a handler
 * that returns the raw `result` a real node would send.
 */
export function fakeNode(handlers: Record<string, Handler>): FakeNode {
  const calls: FakeNode['calls'] = [];
  const unreachable = new Set<string>();
  const transport = (async ({ payload }: { payload: unknown }) => {
    const { id, method, params } = payload as { id: string; method: string; params: readonly unknown[] };
    calls.push({ method, params });
    if (unreachable.has(method)) throw new Error('connect ECONNREFUSED');
    const handler = handlers[method];
    if (!handler) throw new Error(`the fake node has no handler for ${method}`);
    try {
      return { jsonrpc: '2.0', id, result: await handler(params) };
    } catch (error) {
      if (!(error instanceof NodeError)) throw error;
      return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } };
    }
  }) as RpcTransport;
  return { transport, calls, methods: () => calls.map(call => call.method), unreachable };
}

/** A deterministic, syntactically valid address; `seed` picks which one. */
export function addressOf(seed: number): Address {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed + 1);
  return getAddressDecoder().decode(bytes);
}

export interface TokenAccountFields {
  mint: Address;
  owner: Address;
  amount: bigint;
  delegate?: Address;
  delegatedAmount?: bigint;
  frozen?: boolean;
}

/** The `value` of a `getAccountInfo` response for an SPL token account. */
export function tokenAccountInfo(fields: TokenAccountFields) {
  const data = getTokenEncoder().encode({
    mint: fields.mint,
    owner: fields.owner,
    amount: fields.amount,
    delegate: fields.delegate ? some(fields.delegate) : none(),
    state: fields.frozen ? AccountState.Frozen : AccountState.Initialized,
    isNative: none(),
    delegatedAmount: fields.delegatedAmount ?? 0n,
    closeAuthority: none(),
  });
  return accountInfo(TOKEN_PROGRAM_ADDRESS, data);
}

export function accountInfo(
  owner: Address,
  data: Uint8Array | ArrayLike<number> = new Uint8Array(),
  lamports = 2_039_280,
) {
  const bytes = Uint8Array.from(data);
  return {
    data: [getBase64Decoder().decode(bytes), 'base64'],
    executable: false,
    lamports,
    owner,
    rentEpoch: 0,
    space: bytes.length,
  };
}

export const atSlot = <T>(value: T) => ({ context: { slot: 1 }, value });
