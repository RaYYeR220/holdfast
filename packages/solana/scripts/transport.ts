import {
  createDefaultRpcTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from '@solana/kit';
import { sleep } from '../src/confirm';

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

const isRateLimited = (error: unknown): boolean =>
  isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429;

const isAirdropRequest = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && 'method' in payload && payload.method === 'requestAirdrop';

/**
 * The public endpoints answer HTTP 429 once a caller makes more than a few
 * requests per second to one method (ten per window for `getTransaction`).
 * This transport waits and repeats the request instead of failing. Airdrop
 * requests are passed through untouched: their 429 is a daily quota.
 */
export function patientTransport(url: string): RpcTransport {
  const transport = createDefaultRpcTransport({ url });
  return (async config => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(config);
      } catch (error) {
        const delay = BACKOFF_MS[attempt];
        if (delay === undefined || !isRateLimited(error) || isAirdropRequest(config.payload)) throw error;
        await sleep(delay);
      }
    }
  }) as RpcTransport;
}
