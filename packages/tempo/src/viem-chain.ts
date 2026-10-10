import { type Address, type Hex, http, keccak256 } from 'viem';
import { Abis, Account, Addresses, createClient } from 'viem/tempo';
import type { BroadcastResult, ChainLog, ChainReceipt, ForcedTx, PayoutTx, RawKeyState, SignedTx, TempoChain } from './chain';
import { type RailSettings, TempoRailError } from './config';
import { LOG_RANGE, rpcBatchOver, searchMemoLogs } from './log-search';
import { chainOf } from './networks';
import { explainError } from './reasons';

/** JSON-RPC errors that are not a verdict on the transaction: limit exceeded, internal error, too many requests. */
const UNDECIDED_RPC_CODES = [-32005, -32603, 429];

/**
 * The two wallet actions the rail uses. viem's request types cannot describe
 * a Tempo call batch with a fee payer and a nonce lane against a generic
 * chain, so the client is narrowed to this shape once, here.
 */
interface Signer {
  prepareTransactionRequest(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  signTransaction(request: Record<string, unknown>): Promise<Hex>;
}

type RawRequest = (args: { method: string; params: unknown[] }) => Promise<unknown>;

interface ViemLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number | null;
  transactionHash: Hex | null;
  blockNumber: bigint | null;
}

/** A log of an included transaction always says where it sits; one that does not is not taken on trust. */
function toChainLog(log: ViemLog): ChainLog {
  if (log.logIndex === null || log.transactionHash === null || log.blockNumber === null) throw new TempoRailError('the RPC returned a log without its position on chain');
  return { address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex, transactionHash: log.transactionHash, blockNumber: log.blockNumber };
}

/** The JSON-RPC error code somewhere in a viem error chain; null when the node never answered. */
function rpcCodeOf(error: unknown): number | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    // -1 is viem's own code for an error it could not classify.
    if (typeof code === 'number' && code !== -1) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function createViemChain(settings: RailSettings): TempoChain {
  const chain = chainOf(settings.network);
  const url = settings.rpcUrl ?? chain.rpcUrls.default.http[0];
  if (!url) throw new TempoRailError(`no RPC URL is known for ${settings.network}`);
  const transport = http(url);
  // No account on purpose: a read made as the scoped access key is itself refused as an out-of-scope call.
  const reader = createClient({ chain, transport });
  const request = reader.request as unknown as RawRequest;
  const batch = rpcBatchOver(url);
  const sponsor = Account.fromSecp256k1(settings.sponsorPrivateKey);
  const signers = new Map<Address, Signer>();
  let chainChecked: Promise<void> | null = null;
  let logRange = LOG_RANGE;

  /** The access key signs, the transaction's sender is `root`. */
  function signerFor(root: Address): Signer {
    let signer = signers.get(root);
    if (!signer) {
      const account = Account.fromP256(settings.accessKeyPrivateKey, { access: root });
      signer = createClient({ account, chain, transport }) as unknown as Signer;
      signers.set(root, signer);
    }
    return signer;
  }

  function fields(tx: PayoutTx): Record<string, unknown> {
    return {
      calls: tx.calls,
      feePayer: sponsor,
      feeToken: settings.feeToken,
      nonceKey: settings.nonceKey,
      nonce: tx.nonce,
      validBefore: tx.validBefore,
      ...(tx.keyAuthorization ? { keyAuthorization: tx.keyAuthorization } : {}),
    };
  }

  function signed(serialized: Hex): SignedTx {
    return { serialized, hash: keccak256(serialized) };
  }

  return {
    assertChain(): Promise<void> {
      chainChecked ??= reader.getChainId().then((id) => {
        if (id !== chain.id) throw new TempoRailError(`the RPC serves chain ${id}, but ${settings.network} is chain ${chain.id}`);
      });
      return chainChecked.catch((error: unknown) => {
        chainChecked = null;
        throw error;
      });
    },

    async head() {
      const block = await reader.getBlock();
      if (block.number === null) throw new TempoRailError('the RPC returned a head block without a number');
      return { number: block.number, timestamp: Number(block.timestamp), baseFeePerGas: block.baseFeePerGas ?? 0n };
    },

    async keyState(root: Address): Promise<RawKeyState> {
      const keychain = { address: Addresses.accountKeychain, abi: Abis.accountKeychain } as const;
      const [key, limit, allowed] = await Promise.all([
        reader.readContract({ ...keychain, functionName: 'getKey', args: [root, settings.accessKey] }),
        reader.readContract({ ...keychain, functionName: 'getRemainingLimitWithPeriod', args: [root, settings.accessKey, settings.token] }),
        reader.readContract({ ...keychain, functionName: 'getAllowedCalls', args: [root, settings.accessKey] }),
      ]);
      return {
        keyId: key.keyId,
        expiry: key.expiry,
        enforceLimits: key.enforceLimits,
        isRevoked: key.isRevoked,
        remaining: limit[0],
        periodEnd: limit[1],
        isScoped: allowed[0],
        scopes: allowed[1],
      };
    },

    balanceOf(token: Address, owner: Address): Promise<bigint> {
      return reader.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [owner] });
    },

    async laneNonce(root: Address, atBlock?: bigint): Promise<number> {
      // Pinned to a block number, the read is refused by a node that does not have that block yet ("block not found").
      const at = atBlock === undefined ? {} : { blockNumber: atBlock };
      return Number(await reader.nonce.getNonce({ account: root, nonceKey: settings.nonceKey, ...at }));
    },

    async memoLogs({ root, memos, fromBlock, toBlock }): Promise<ChainLog[]> {
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const found = await searchMemoLogs({ rpc: batch, token: settings.token, root, memos, fromBlock, toBlock, sleep, span: logRange });
      logRange = found.span;
      return found.logs;
    },

    async receipt(hash: Hex): Promise<ChainReceipt | null> {
      try {
        const receipt = await reader.getTransactionReceipt({ hash });
        if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
        return { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, logs: receipt.logs.map(toChainLog) };
      } catch (error) {
        // "Not found" is the one answer that means the transaction is not in a block; every other failure stays a failure.
        if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      }
    },

    async signPayout(tx: PayoutTx): Promise<SignedTx> {
      const signer = signerFor(tx.root);
      // Filling the request runs the batch through the node's simulation; a keychain violation is rejected here.
      const prepared = await signer.prepareTransactionRequest(fields(tx));
      return signed(await signer.signTransaction(prepared));
    },

    async signForced(tx: ForcedTx): Promise<SignedTx> {
      // Every field is given, so nothing is estimated and nothing is simulated.
      const serialized = await signerFor(tx.root).signTransaction({
        ...fields(tx),
        chainId: chain.id,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: 1n,
        type: 'tempo',
      });
      return signed(serialized);
    },

    async broadcast(serialized: Hex): Promise<BroadcastResult> {
      try {
        await request({ method: 'eth_sendRawTransaction', params: [serialized] });
        return { accepted: true };
      } catch (error) {
        const code = rpcCodeOf(error);
        // No answer, a rate limit or an internal error says nothing about whether the node kept the bytes.
        if (code === null || UNDECIDED_RPC_CODES.includes(code)) throw error;
        const reason = explainError(error);
        // The node already holds these exact bytes, which is what was asked for.
        return /already known/i.test(reason) ? { accepted: true } : { accepted: false, reason };
      }
    },

    async revertData(hash: Hex): Promise<Hex | null> {
      try {
        // The default struct tracer reports the four-byte error of a failed transaction as `returnValue`.
        const trace = (await request({ method: 'debug_traceTransaction', params: [hash, {}] })) as { failed?: boolean; returnValue?: unknown } | null;
        const value = trace?.returnValue;
        if (!trace?.failed || typeof value !== 'string' || value === '' || value === '0x') return null;
        return (value.startsWith('0x') ? value : `0x${value}`) as Hex;
      } catch {
        // Only ever used to name the reason of a revert the receipt already established.
        return null;
      }
    },
  };
}
