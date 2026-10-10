import { type Address, type Hex, getAbiItem, http, keccak256 } from 'viem';
import { Abis, Account, Addresses, createClient } from 'viem/tempo';
import type { BroadcastResult, ChainLog, ChainReceipt, ForcedTx, PayoutTx, RawKeyState, SignedTx, TempoChain } from './chain';
import { type RailSettings, TempoRailError } from './config';
import { chainOf } from './networks';
import { explainError } from './reasons';

const transferWithMemoEvent = getAbiItem({ abi: Abis.tip20, name: 'TransferWithMemo' });

/** Public Tempo RPCs refuse `eth_getLogs` over more blocks than this; the error names the real limit when it differs. */
const LOG_RANGE = 100_000n;
/** Ranges queried at once. The public RPC starts rate limiting above this. */
const LOG_CONCURRENCY = 4;
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

function toChainLog(log: ViemLog): ChainLog {
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    logIndex: log.logIndex ?? 0,
    transactionHash: log.transactionHash ?? '0x',
    blockNumber: log.blockNumber ?? 0n,
  };
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

function rangeLimitOf(error: unknown): bigint | null {
  const match = /max block range (\d+)/i.exec(explainError(error));
  return match?.[1] ? BigInt(match[1]) : null;
}

type BlockRange = [from: bigint, to: bigint];

/** Split `fromBlock..toBlock` into inclusive ranges of at most `span` blocks, newest first. */
export function blockRanges(fromBlock: bigint, toBlock: bigint, span: bigint): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (let to = toBlock; to >= fromBlock; to -= span) {
    ranges.push([to - fromBlock >= span ? to - span + 1n : fromBlock, to]);
  }
  return ranges;
}

export function createViemChain(settings: RailSettings): TempoChain {
  const chain = chainOf(settings.network);
  const transport = settings.rpcUrl === null ? http() : http(settings.rpcUrl);
  // No account on purpose: a read made as the scoped access key is itself refused as an out-of-scope call.
  const reader = createClient({ chain, transport });
  const request = reader.request as unknown as RawRequest;
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
      return { number: block.number ?? 0n, timestamp: Number(block.timestamp), baseFeePerGas: block.baseFeePerGas ?? 0n };
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

    async laneNonce(root: Address): Promise<number> {
      return Number(await reader.nonce.getNonce({ account: root, nonceKey: settings.nonceKey }));
    },

    async memoLogs({ root, memos, fromBlock, toBlock }): Promise<ChainLog[]> {
      const query = async ([from, to]: BlockRange): Promise<ChainLog[]> => {
        const logs = await reader.getLogs({ address: settings.token, event: transferWithMemoEvent, args: { from: root, memo: memos }, fromBlock: from, toBlock: to });
        return logs.map(toChainLog);
      };
      let ranges = blockRanges(fromBlock, toBlock, logRange);
      const newest = ranges[0];
      if (!newest) return [];
      // The newest range goes first and alone: it is where a retried run usually is, and it shows how wide a range the RPC accepts.
      const logs = await query(newest).catch((error: unknown) => {
        const limit = rangeLimitOf(error);
        if (limit === null || limit <= 0n || limit >= logRange) throw error;
        logRange = limit;
        ranges = blockRanges(fromBlock, toBlock, logRange);
        return query(ranges[0] ?? newest);
      });
      for (let i = 1; i < ranges.length; i += LOG_CONCURRENCY) {
        const batch = await Promise.all(ranges.slice(i, i + LOG_CONCURRENCY).map(query));
        logs.push(...batch.flat());
      }
      return logs;
    },

    async receipt(hash: Hex): Promise<ChainReceipt | null> {
      try {
        const receipt = await reader.getTransactionReceipt({ hash });
        if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
        return { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, logs: receipt.logs.map(toChainLog) };
      } catch (error) {
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
        return null;
      }
    },
  };
}
