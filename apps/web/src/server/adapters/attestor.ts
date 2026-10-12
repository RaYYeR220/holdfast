import { hedgeAttestorAbi, readSeries, readSnapshot, verifyOnChain } from '@holdfast/attest';
import { type Address, BaseError, ContractFunctionRevertedError, type Hex, TransactionReceiptNotFoundError, type Transport, createPublicClient, defineChain, encodeFunctionData, http, isAddressEqual, keccak256, parseEventLogs, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AttestorSettings } from '../config';
import type { AttestationCall, AttestationReceipt, AttestorPort, ContractRefusal } from '../deps';
import { messageOf } from '../redact';

/**
 * Gas given to an attestation. One has used about 166,000; the limit is fixed
 * and generous so that the node is not asked for an estimate before sending.
 */
export const ATTEST_GAS_LIMIT = 400_000n;
/** The price offered is this many times what the node quotes, so that a rising base fee does not strand the transaction. */
export const GAS_PRICE_MULTIPLE = 2n;

const RPC_TIMEOUT_MS = 10_000;
const RECEIPT_POLL_MS = 1_000;

export interface AttestorIo {
  /** Stands in for HTTP to the configured endpoint. */
  transport?: Transport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The contract's refusal inside an error from viem, when the node returned one the ABI names. */
function refusalIn(error: unknown): ContractRefusal | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError) || reverted.data === undefined) return null;
  const { errorName, args } = reverted.data;
  return { error: errorName, text: `${errorName}(${(args ?? []).map(String).join(', ')})` };
}

/** Why a call failed, in one line. viem's full message repeats the request, its endpoint among it. */
function reasonOf(error: unknown): string {
  const refusal = refusalIn(error);
  if (refusal !== null) return `the contract answered ${refusal.text}`;
  if (!(error instanceof BaseError)) return messageOf(error);
  return error.details === '' || error.details === error.shortMessage ? error.shortMessage : `${error.shortMessage} ${error.details}`;
}

async function asked<T>(what: string, ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    throw new Error(`${what} failed: ${reasonOf(error)}`);
  }
}

const argsOf = (perpIndex: number, call: AttestationCall) => [call.user, perpIndex, call.journalRoot, call.journalCount, call.treasuryCommitment] as const;

/**
 * The HedgeAttestor contract on HyperEVM, over JSON-RPC. `io` replaces the
 * endpoint and the clock in tests.
 */
export function attestorPort(settings: AttestorSettings, io: AttestorIo = {}): AttestorPort {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const chain = defineChain({
    id: settings.chainId,
    name: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: [settings.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: io.transport ?? http(settings.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }) });
  const { contract, perp } = settings;

  async function recordedBy(hash: Hex): Promise<AttestationReceipt | null> {
    let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
    try {
      receipt = await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
    // Only the contract's own event says what was recorded; a log of the same shape from elsewhere says nothing.
    const [attested] = parseEventLogs({ abi: hedgeAttestorAbi, eventName: 'Attested', logs: receipt.logs }).filter((log) => isAddressEqual(log.address, contract));
    return {
      ok: receipt.status === 'success',
      recorded: attested === undefined ? null : { user: attested.args.user, snapshot: { series: attested.args.series, number: attested.args.number, ...attested.args.snapshot } },
    };
  }

  return {
    chainId: settings.chainId,
    contract,
    perp,
    everyMs: settings.everyMinutes * 60_000,

    async attesterOf(user) {
      const attester = await asked('attesterOf', () => client.readContract({ address: contract, abi: hedgeAttestorAbi, functionName: 'attesterOf', args: [user] }));
      return isAddressEqual(attester, zeroAddress) ? null : attester;
    },

    series: (user, series) => asked('reading the series', () => readSeries(client, contract, user, series)),

    snapshot: (user, series, number) => asked('reading the snapshot', () => readSnapshot(client, contract, user, series, number)),

    verifyEntry: (user, series, number, leaf, proof) => asked('verifyEntry', () => verifyOnChain(client, contract, user, series, number, leaf, proof)),

    async refusalOf(attester, call) {
      try {
        // Under the gas the transaction would carry, so that what passes here does not run out of it there.
        await client.simulateContract({ address: contract, abi: hedgeAttestorAbi, functionName: 'attest', args: argsOf(perp.index, call), account: attester, gas: ATTEST_GAS_LIMIT });
        return null;
      } catch (error) {
        const refusal = refusalIn(error);
        if (refusal !== null) return refusal;
        throw new Error(`asking the contract failed: ${reasonOf(error)}`);
      }
    },

    async sign(attesterPrivateKey, call) {
      // A key that is not one is refused in words of our own: the library's would quote it.
      const account = (() => {
        try {
          return privateKeyToAccount(attesterPrivateKey);
        } catch {
          throw new Error('preparing the attestation failed: the attester key is not a private key');
        }
      })();
      return asked('preparing the attestation', async () => {
        const [nonce, gasPrice] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'pending' }), client.getGasPrice()]);
        // A legacy transaction with its price and limit stated: the public endpoint at times refuses the fee
        // history an EIP-1559 estimate is made from, and nothing here may depend on an estimate.
        const raw = await account.signTransaction({
          chainId: settings.chainId,
          type: 'legacy',
          nonce,
          gasPrice: gasPrice * GAS_PRICE_MULTIPLE,
          gas: ATTEST_GAS_LIMIT,
          to: contract,
          value: 0n,
          data: encodeFunctionData({ abi: hedgeAttestorAbi, functionName: 'attest', args: argsOf(perp.index, call) }),
        });
        return { hash: keccak256(raw), raw };
      });
    },

    async broadcast(raw) {
      await asked('sending the attestation', () => client.sendRawTransaction({ serializedTransaction: raw }));
    },

    async receipt(hash, waitMs = 0) {
      const deadline = now() + waitMs;
      for (;;) {
        const found = await asked('reading the receipt', () => recordedBy(hash));
        if (found !== null) return found;
        const left = deadline - now();
        if (left <= 0) return null;
        await sleep(Math.min(RECEIPT_POLL_MS, left));
      }
    },
  };
}
