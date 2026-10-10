import { HyperliquidTransportError } from './errors';
import { excerpt, isRecord } from './parse';

export type Network = 'mainnet' | 'testnet';

export const API_URL: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz',
};

const DEFAULT_TIMEOUT_MS = 10_000;

export interface TransportOptions {
  network: Network;
  fetch?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  /** Per-request timeout; a request that hangs must not stall the controller. */
  timeoutMs?: number | undefined;
}

export interface Transport {
  network: Network;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
}

export function createTransport(options: TransportOptions): Transport {
  return {
    network: options.network,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? Date.now,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

interface HttpReply {
  /** Null when no HTTP response was received. */
  status: number | null;
  /** Parsed JSON, the raw text when it was not JSON, null when there was no response. */
  body: unknown;
  isJson: boolean;
  failure: string | null;
}

function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return `timed out after ${timeoutMs} ms`;
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

async function post(transport: Transport, path: 'info' | 'exchange', payload: unknown): Promise<HttpReply> {
  let status: number | null = null;
  try {
    const response = await transport.fetch(`${API_URL[transport.network]}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(transport.timeoutMs),
    });
    status = response.status;
    const text = await response.text();
    try {
      return { status, body: JSON.parse(text) as unknown, isJson: true, failure: null };
    } catch {
      return { status, body: text, isJson: false, failure: null };
    }
  } catch (error) {
    return { status, body: null, isJson: false, failure: describeFailure(error, transport.timeoutMs) };
  }
}

/** Read from the info endpoint. Throws unless Hyperliquid answered 200 with JSON. */
export async function postInfo(transport: Transport, request: { type: string } & Record<string, unknown>): Promise<unknown> {
  const reply = await post(transport, 'info', request);
  if (reply.failure !== null) {
    throw new HyperliquidTransportError(`info ${request.type}: ${reply.failure}`, reply.status);
  }
  if (reply.status !== 200 || !reply.isJson) {
    throw new HyperliquidTransportError(`info ${request.type}: HTTP ${reply.status}: ${excerpt(reply.body)}`, reply.status);
  }
  return reply.body;
}

/** What came back from one POST to the exchange endpoint. Never thrown, always returned. */
export interface ExchangeReply {
  /** True only for HTTP 200 with `{"status":"ok"}`. Per-order errors can still sit inside. */
  ok: boolean;
  /** False when no HTTP response was received, so the action may or may not have landed. */
  delivered: boolean;
  httpStatus: number | null;
  /** Hyperliquid's body, verbatim: parsed JSON, or the raw text when it was not JSON. */
  response: unknown;
  error: string | null;
}

export interface SignedAction {
  action: object;
  nonce: number;
  signature: { r: `0x${string}`; s: `0x${string}`; v: 27 | 28 };
}

export async function postExchange(transport: Transport, signed: SignedAction): Promise<ExchangeReply> {
  const reply = await post(transport, 'exchange', signed);
  if (reply.status === null) {
    return { ok: false, delivered: false, httpStatus: null, response: null, error: `request failed: ${reply.failure}` };
  }

  const base = { delivered: true, httpStatus: reply.status, response: reply.body };
  if (reply.failure !== null) {
    return { ...base, ok: false, error: `HTTP ${reply.status}, body unreadable: ${reply.failure}` };
  }
  if (reply.status !== 200) {
    return { ...base, ok: false, error: `HTTP ${reply.status}: ${excerpt(reply.body)}` };
  }
  if (isRecord(reply.body) && reply.body.status === 'ok') {
    return { ...base, ok: true, error: null };
  }
  if (isRecord(reply.body) && reply.body.status === 'err') {
    return { ...base, ok: false, error: excerpt(reply.body.response) };
  }
  return { ...base, ok: false, error: `unexpected response: ${excerpt(reply.body)}` };
}

/**
 * True when Hyperliquid itself processed the action and turned it down:
 * HTTP 200 carrying `{"status":"err","response":"..."}`. A dropped connection,
 * a rate limit or a malformed-request 422 is not a refusal of the action.
 */
export function isExchangeRefusal(reply: Pick<ExchangeReply, 'httpStatus' | 'response'>): boolean {
  return reply.httpStatus === 200 && isRecord(reply.response) && reply.response.status === 'err';
}
