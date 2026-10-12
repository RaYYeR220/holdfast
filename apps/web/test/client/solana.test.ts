import { getWallets } from '@wallet-standard/app';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Api, type SolanaRail, createApi } from '../../src/client/api';
import { ClientError } from '../../src/client/errors';
import {
  type SolanaWallet,
  approveSolanaDelegate,
  associatedTokenAddress,
  base58Decode,
  base58Encode,
  checkOwnerTransaction,
  connectSolanaWallet,
  readSolanaTransaction,
  revokeSolanaDelegate,
  solanaChainOf,
  solanaTxUrl,
  waitForSolanaAllowance,
  watchSolanaWallets,
} from '../../src/client/solana';
import { buildDelegateApproval, buildDelegateRevoke } from '../../src/server/adapters/solana-package.js';
import { wireShape } from '../../src/server/json';
import { type FakeSolanaWallet, fakeSolanaWallet, fakeWindow } from './support/wallets';

const ORG = '7b0e7a52-8b65-4f0e-9d3a-2f1c4c1f9a10';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const DELEGATE = base58Encode(new Uint8Array(32).fill(9));
const STRANGER = base58Encode(new Uint8Array(32).fill(3));
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(7));

/** The node the server's builder asks for a recent blockhash, answering as a real one does. */
const node = {
  rpcUrl: 'http://node.invalid',
  transport: async ({ payload }: { payload: unknown }) => {
    const { id, method } = payload as { id: string; method: string };
    if (method !== 'getLatestBlockhash') throw new Error(`the node was asked for ${method}`);
    return { jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 4_242 } } };
  },
};

/** The unsigned transactions exactly as the server makes them: built by the Solana package, through the adapter's own import. */
const approval = (owner: string, amount: bigint, delegate = DELEGATE) => buildDelegateApproval({ ...node, owner, mint: MINT, decimals: 6, delegate, amount });
const revocation = (owner: string) => buildDelegateRevoke({ ...node, owner, mint: MINT });
const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

async function failure(promise: Promise<unknown>): Promise<ClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

function refusalOf(run: () => unknown): ClientError {
  try {
    run();
  } catch (error) {
    if (error instanceof ClientError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const registered: (() => void)[] = [];
/** Register a wallet the way a wallet does once the page is ready for it. */
function register(fake: FakeSolanaWallet): void {
  registered.push(getWallets().register(fake.wallet));
}
function listed(): SolanaWallet[] {
  let wallets: SolanaWallet[] = [];
  watchSolanaWallets((found) => {
    wallets = found;
  })();
  return wallets;
}
function walletOf(fake: FakeSolanaWallet): SolanaWallet {
  const wallet = listed().find((candidate) => candidate.handle === fake.wallet);
  if (wallet === undefined) throw new Error('the wallet is not listed');
  return wallet;
}

afterEach(() => {
  for (const unregister of registered.splice(0)) unregister();
  vi.unstubAllGlobals();
});

describe('base58', () => {
  it('encodes the published vectors, and decodes them again', () => {
    const ascii = (text: string) => new TextEncoder().encode(text);
    const vectors: [Uint8Array, string][] = [
      [new Uint8Array(), ''],
      [ascii('Hello World!'), '2NEpo7TZRRrLZSi2U'],
      [ascii('The quick brown fox jumps over the lazy dog.'), 'USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z'],
      [new Uint8Array([0x00, 0x00, 0x28, 0x7f, 0xb4, 0xcd]), '11233QC4'],
      // The System program: thirty-two zero bytes.
      [new Uint8Array(32), '11111111111111111111111111111111'],
    ];
    for (const [bytes, text] of vectors) {
      expect(base58Encode(bytes)).toBe(text);
      expect(base58Decode(text)).toEqual(bytes);
    }
    // The alphabet has no 0, O, I or l.
    for (const text of ['0', 'O', 'I', 'l', 'abc def', 'ab+c']) expect(() => base58Decode(text), text).toThrow(RangeError);
  });
});

describe('the token account of a wallet', () => {
  // Forty derivations on a busy machine can take longer than the default five seconds.
  it('is the address the Solana package derives, for any wallet', { timeout: 30_000 }, async () => {
    // Half of all candidate addresses are points of the curve and are skipped, so a few dozen wallets go through every path.
    for (let i = 0; i < 40; i += 1) {
      const owner = base58Encode(new Uint8Array(32).fill(i + 1).map((byte, at) => (byte * 31 + at * 17 + i) & 0xff));
      const built = await revocation(owner);
      expect(await associatedTokenAddress(owner, MINT), owner).toBe(built.summary.tokenAccount);
    }
    const fake = await fakeSolanaWallet();
    expect(await associatedTokenAddress(fake.address, MINT)).toBe((await approval(fake.address, 1n)).summary.tokenAccount);
    // Another mint is another account.
    expect(await associatedTokenAddress(fake.address, STRANGER)).not.toBe(await associatedTokenAddress(fake.address, MINT));
  });

  it('is not worked out for what is no address', async () => {
    for (const [owner, mint] of [['not-an-address', MINT], [STRANGER, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'], ['', MINT], [STRANGER, '111']] as const) {
      expect((await failure(associatedTokenAddress(owner, mint))).code).toBe('invalid_argument');
    }
  });
});

describe('reading a transaction the server prepared', () => {
  it('finds in an approval the one signer and the one instruction', async () => {
    const fake = await fakeSolanaWallet();
    const built = await approval(fake.address, 25_000_000n);
    const transaction = readSolanaTransaction(bytesOf(built.transaction));

    expect(transaction.version).toBe(0);
    expect(transaction.signers).toEqual([fake.address]);
    expect(transaction.unsigned).toBe(true);
    expect(transaction.instructions).toHaveLength(1);
    const [instruction] = transaction.instructions;
    // The addresses are the ones the Solana package itself wrote, which also checks the encoding here against theirs.
    expect(instruction?.program).toBe(TOKEN_PROGRAM);
    expect(instruction?.accounts).toEqual([built.summary.tokenAccount, MINT, DELEGATE, fake.address]);
    expect([...(instruction?.data ?? [])]).toEqual([13, 0x40, 0x78, 0x7d, 0x01, 0, 0, 0, 0, 6]);
    expect(transaction.message).toEqual(bytesOf(built.transaction).slice(65));
  });

  it('accepts the approval and the revocation that were asked for', async () => {
    const fake = await fakeSolanaWallet();
    const tokenAccount = await associatedTokenAddress(fake.address, MINT);
    const approve = bytesOf((await approval(fake.address, 25_000_000n)).transaction);
    const revoke = bytesOf((await revocation(fake.address)).transaction);
    expect(checkOwnerTransaction(approve, { kind: 'approval', owner: fake.address, tokenAccount, mint: MINT, delegate: DELEGATE, amount: 25_000_000n, decimals: 6 }).signers).toEqual([fake.address]);
    expect(checkOwnerTransaction(revoke, { kind: 'revoke', owner: fake.address, tokenAccount }).instructions[0]?.data).toEqual(new Uint8Array([5]));
  });

  it('refuses whatever is not that, before any wallet sees it', async () => {
    const fake = await fakeSolanaWallet();
    const tokenAccount = await associatedTokenAddress(fake.address, MINT);
    const approve = bytesOf((await approval(fake.address, 25_000_000n)).transaction);
    const revoke = bytesOf((await revocation(fake.address)).transaction);
    const wanted = { kind: 'approval', owner: fake.address, tokenAccount, mint: MINT, delegate: DELEGATE, amount: 25_000_000n, decimals: 6 } as const;
    const unwanted = { kind: 'revoke', owner: fake.address, tokenAccount } as const;
    // The wallet's account for another token: an account of the same wallet, and not the one the delegate is to be let into.
    const otherAccount = await associatedTokenAddress(fake.address, STRANGER);

    /** The same transaction with one byte of its instruction data changed. */
    const withData = (wire: Uint8Array, offsetFromEnd: number, value: number) => {
      const changed = wire.slice();
      changed[changed.length - offsetFromEnd] = value;
      return changed;
    };
    const signed = approve.slice();
    signed.fill(1, 1, 65);
    const cases: [string, Uint8Array, Parameters<typeof checkOwnerTransaction>[1], string][] = [
      ['an approval for another amount', approve, { ...wanted, amount: 25_000_001n }, 'approves another amount'],
      ['an approval of another delegate', approve, { ...wanted, delegate: STRANGER }, 'approves another delegate'],
      ['an approval for another token', approve, { ...wanted, mint: STRANGER }, 'approves another delegate, or does so for another token'],
      ['an approval with other decimals', approve, { ...wanted, decimals: 9 }, 'approves another amount'],
      ['an approval on another token account of the same wallet', approve, { ...wanted, tokenAccount: otherAccount }, 'on another token account than the wallet’s own'],
      ['a transaction for another wallet to sign', approve, { ...wanted, owner: STRANGER }, 'is not signed and paid for by the wallet of the organisation alone'],
      ['a revocation where an approval was asked for', revoke, wanted, 'is not an approval of a delegate'],
      ['an approval where a revocation was asked for', approve, unwanted, 'is not the revocation of a delegate'],
      ['a revocation for another wallet', revoke, { ...unwanted, owner: STRANGER }, 'is not signed and paid for'],
      ['a revocation on another token account of the same wallet', revoke, { ...unwanted, tokenAccount: otherAccount }, 'on another token account than the wallet’s own'],
      // The count of address lookup tables is the last byte, after the ten bytes of instruction data. Twelve is TransferChecked, which takes the same accounts.
      ['a transfer in the place of the approval', withData(approve, 11, 12), wanted, 'is not an approval of a delegate'],
      ['a transaction that is already signed', signed, wanted, 'already carries a signature'],
      ['a transaction that loads accounts from a lookup table', withData(approve, 1, 1), wanted, 'loads accounts from a lookup table'],
      ['a transaction with bytes after its end', new Uint8Array([...approve, 0]), wanted, 'has bytes after its end'],
      ['a transaction cut short', approve.slice(0, approve.length - 20), wanted, 'cannot be read'],
      ['bytes that are no transaction', new TextEncoder().encode(`approve:${fake.address}:${DELEGATE}:25000000`), wanted, 'cannot be read'],
      ['nothing at all', new Uint8Array(), wanted, 'cannot be read'],
    ];
    for (const [what, wire, expected, why] of cases) {
      const error = refusalOf(() => checkOwnerTransaction(wire, expected));
      expect(error.code, what).toBe('unexpected_request');
      expect(error.message, what).toMatch(/^the transaction the server prepared /);
      expect(error.message, what).toContain(why);
    }
  });

  it('reads a length only as Solana writes it', async () => {
    const fake = await fakeSolanaWallet();
    const approve = bytesOf((await approval(fake.address, 25_000_000n)).transaction);
    // The transaction opens with the number of signatures, one, written in a single byte.
    expect(approve[0]).toBe(1);
    const reencoded = (...length: number[]) => new Uint8Array([...length, ...approve.slice(1)]);
    // The same number in more bytes than it needs, and numbers no two bytes of sixteen bits can hold.
    for (const bytes of [[0x81, 0x00], [0x81, 0x80, 0x00], [0x81, 0x80, 0x04], [0x81, 0x80, 0x80]]) {
      expect(() => readSolanaTransaction(reencoded(...bytes)), bytes.join(' ')).toThrow('a length in the transaction is malformed');
    }
    // A legacy transaction is read as well: the same message without the version byte and the table count.
    const legacy = new Uint8Array([...approve.slice(0, 65), ...approve.slice(66, approve.length - 1)]);
    const read = readSolanaTransaction(legacy);
    expect(read.version).toBe('legacy');
    expect(read.signers).toEqual([fake.address]);
    expect(read.instructions).toEqual(readSolanaTransaction(approve).instructions);
  });

  it('names the chain of a cluster the way wallets do, and where a transaction can be looked at', () => {
    expect(solanaChainOf('mainnet-beta')).toBe('solana:mainnet');
    expect(solanaChainOf('devnet')).toBe('solana:devnet');
    expect(() => solanaChainOf('testnet')).toThrow(ClientError);
    expect(solanaTxUrl('5sig', 'devnet')).toBe('https://explorer.solana.com/tx/5sig?cluster=devnet');
    expect(solanaTxUrl('5sig', 'mainnet-beta')).toBe('https://explorer.solana.com/tx/5sig');
  });
});

describe('finding and connecting Solana wallets', () => {
  it('lists the wallets registered through Wallet Standard that can sign and send, as they come and go', async () => {
    const seen: string[][] = [];
    const stop = watchSolanaWallets((wallets) => seen.push(wallets.map((wallet) => wallet.name)));
    expect(seen).toEqual([[]]);

    const phantom = await fakeSolanaWallet({ name: 'Phantom' });
    const unregister = getWallets().register(phantom.wallet);
    // A wallet that only signs cannot send, and one for another chain is no Solana wallet.
    register(await fakeSolanaWallet({ name: 'Signs Only', features: 'sign-only' }));
    register(await fakeSolanaWallet({ name: 'Elsewhere', chains: ['sui:mainnet' as never] }));
    register(await fakeSolanaWallet({ name: 'Solflare' }));
    expect(seen.at(-1)).toEqual(['Phantom', 'Solflare']);

    const [first] = listed();
    expect(first).toMatchObject({ id: 'standard:Phantom', name: 'Phantom', source: 'standard', chains: ['solana:mainnet', 'solana:devnet'], icon: 'data:image/svg+xml;base64,PHN2Zy8+' });

    unregister();
    expect(seen.at(-1)).toEqual(['Solflare']);
    stop();
    register(await fakeSolanaWallet({ name: 'Late' }));
    expect(seen.at(-1)).toEqual(['Solflare']);
  });

  it('connects once the treasurer agrees, and finds the account again without asking', async () => {
    const fake = await fakeSolanaWallet();
    register(fake);
    const wallet = walletOf(fake);

    expect(await connectSolanaWallet(wallet, { silent: true })).toBeNull();
    expect(fake.prompts).toBe(0);

    const connection = await connectSolanaWallet(wallet);
    expect(connection.address()).toBe(fake.address);
    expect(connection.wallet.name).toBe('Fake Wallet');
    expect(fake.prompts).toBe(1);

    const again = await connectSolanaWallet(wallet, { silent: true });
    expect(again?.address()).toBe(fake.address);
    expect(fake.prompts).toBe(1);
  });

  it('follows the wallet to another account, and lets go of it on disconnect', async () => {
    const fake = await fakeSolanaWallet();
    register(fake);
    const connection = await connectSolanaWallet(walletOf(fake));
    const seen: (string | null)[] = [];
    connection.subscribe((address) => seen.push(address));

    const next = await fake.switchAccount();
    expect(seen).toEqual([next]);
    expect(connection.address()).toBe(next);

    await connection.disconnect();
    expect(seen).toEqual([next, null]);
    expect(connection.address()).toBeNull();
    expect(fake.wallet.accounts).toEqual([]);
    await fake.switchAccount();
    expect(seen).toHaveLength(2);
    expect((await failure(connection.signAndSend(new Uint8Array([1]), 'solana:devnet'))).code).toBe('wallet_unavailable');
  });

  it('falls back on the provider an older wallet leaves on window, while none has registered', async () => {
    const owner = await fakeSolanaWallet();
    const requests: { method: string; params?: unknown }[] = [];
    const listeners = new Map<string, (payload: unknown) => void>();
    let trusted = false;
    const provider = {
      connect: async (options?: { onlyIfTrusted?: boolean }) => {
        if (options?.onlyIfTrusted === true && !trusted) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        trusted = true;
        return { publicKey: { toString: () => owner.address } };
      },
      disconnect: async () => {
        trusted = false;
      },
      request: async (args: { method: string; params?: unknown }) => {
        requests.push(args);
        return { signature: '5sigFromTheWallet', publicKey: owner.address };
      },
      on: (event: string, listener: (payload: unknown) => void) => void listeners.set(event, listener),
      off: (event: string) => void listeners.delete(event),
    };
    const page = fakeWindow();
    page.phantom = { solana: provider };
    vi.stubGlobal('window', page);

    const [wallet] = listed();
    expect(wallet).toMatchObject({ id: 'injected', name: 'Browser wallet', source: 'injected', chains: [] });
    if (wallet === undefined) throw new Error('unreachable');
    expect(await connectSolanaWallet(wallet, { silent: true })).toBeNull();
    const connection = await connectSolanaWallet(wallet);
    expect(connection.address()).toBe(owner.address);

    // It is handed the message to sign, in base58, as Phantom documents the request.
    const wire = bytesOf((await approval(owner.address, 5_000_000n)).transaction);
    expect(await connection.signAndSend(wire, 'solana:mainnet')).toBe('5sigFromTheWallet');
    expect(requests).toEqual([{ method: 'signAndSendTransaction', params: { message: base58Encode(wire.slice(65)) } }]);

    const seen: (string | null)[] = [];
    connection.subscribe((address) => seen.push(address));
    listeners.get('accountChanged')?.({ toString: () => STRANGER });
    listeners.get('accountChanged')?.(null);
    expect(seen).toEqual([STRANGER, null]);
    await connection.disconnect();
    expect([...listeners.keys()]).toEqual([]);

    // Once a wallet registers the standard way, the provider on window is no longer offered.
    register(await fakeSolanaWallet({ name: 'Phantom' }));
    expect(listed().map((found) => found.id)).toEqual(['standard:Phantom']);
  });
});

describe('approving and revoking the delegate', () => {
  interface ServerOptions {
    /** The delegate the rail names, and the service key the organisation's profile lists; one and the same unless the server contradicts itself. */
    delegate?: string | null;
    serviceKey?: string | null;
    /** The wallet the profile names, where it is not the rail's. */
    profileOwner?: string | null;
    cluster?: string;
    allowance?: () => string;
    /** What the server builds the approval for, where that is not what was asked. */
    tamper?: (amount: bigint) => bigint;
    builtFor?: string;
    builtDelegate?: string;
  }

  /** The server as the flows meet it: the organisation, its rail, and the two transactions built for whoever the organisation's wallet is. */
  function server(owner: string, options: ServerOptions = {}) {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const delegate = options.delegate === undefined ? DELEGATE : options.delegate;
    const serviceKey = options.serviceKey === undefined ? delegate : options.serviceKey;
    const rail = (): SolanaRail => ({
      cluster: options.cluster ?? 'devnet',
      token: { address: MINT, symbol: 'USDC', decimals: 6 },
      owner,
      delegate,
      allowance: { status: 'ok', source: 'solana', readAt: 1, value: { remaining: options.allowance?.() ?? '0' } },
    });
    const serve: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body === undefined || init.body === null ? undefined : (JSON.parse(String(init.body)) as { amount?: string });
      calls.push({ method: init?.method ?? 'GET', url, body });
      if (url === `/api/orgs/${ORG}`) {
        return Response.json({ id: ORG, solanaOwner: options.profileOwner === undefined ? owner : options.profileOwner, serviceKeys: serviceKey === null ? [] : [{ kind: 'tempo_access', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }, { kind: 'solana_delegate', address: serviceKey }] });
      }
      if (url.endsWith('/rails/solana')) return Response.json(rail());
      if (url.endsWith('/rails/solana/approval')) {
        if (delegate === null) return Response.json({ error: 'refused', message: 'the organisation has no Solana service key' }, { status: 409 });
        const amount = BigInt(body?.amount ?? '0');
        return Response.json(wireShape(await approval(options.builtFor ?? owner, options.tamper?.(amount) ?? amount, options.builtDelegate ?? delegate)));
      }
      if (url.endsWith('/rails/solana/revoke')) return Response.json(wireShape(await revocation(options.builtFor ?? owner)));
      return Response.json({ error: 'not_found', message: 'not found' }, { status: 404 });
    };
    const api: Api = createApi({ fetch: serve });
    return { api, calls, serve };
  }

  async function connected(options: Parameters<typeof fakeSolanaWallet>[0] = {}) {
    const fake = await fakeSolanaWallet(options);
    register(fake);
    return { fake, connection: await connectSolanaWallet(walletOf(fake)) };
  }

  it('has the wallet sign and send the approval, and reports the signature of what was sent', async () => {
    const { fake, connection } = await connected();
    const { api, calls } = server(fake.address);

    const submission = await approveSolanaDelegate(connection, ORG, 25_000_000n, { api });
    expect(calls).toEqual([
      { method: 'GET', url: `/api/orgs/${ORG}`, body: undefined },
      { method: 'GET', url: `/api/orgs/${ORG}/rails/solana`, body: undefined },
      { method: 'POST', url: `/api/orgs/${ORG}/rails/solana/approval`, body: { amount: '25000000' } },
    ]);

    expect(fake.sent).toHaveLength(1);
    const [sent] = fake.sent;
    if (sent === undefined) throw new Error('unreachable');
    expect(sent.chain).toBe('solana:devnet');
    expect(submission).toEqual({ signature: base58Encode(sent.signature), txUrl: `https://explorer.solana.com/tx/${base58Encode(sent.signature)}?cluster=devnet`, lastValidBlockHeight: '4242' });

    // What went out is the transaction the server built, with the owner's signature over its message in the one slot.
    const unsigned = bytesOf((await approval(fake.address, 25_000_000n)).transaction);
    const signed = readSolanaTransaction(sent.wire);
    expect(signed.unsigned).toBe(false);
    expect(signed.message).toEqual(readSolanaTransaction(unsigned).message);
    expect(signed.signers).toEqual([fake.address]);
    expect(signed.signatures).toEqual([sent.signature]);
    expect(await fake.verify(signed.message, sent.signature)).toBe(true);
    expect(await fake.verify(signed.message.slice(1), sent.signature)).toBe(false);
    expect(signed.instructions[0]).toMatchObject({ program: TOKEN_PROGRAM, accounts: [await associatedTokenAddress(fake.address, MINT), MINT, DELEGATE, fake.address] });
  });

  it('has the wallet sign and send the revocation', async () => {
    const { fake, connection } = await connected();
    const { api, calls } = server(fake.address, { cluster: 'mainnet-beta' });

    const submission = await revokeSolanaDelegate(connection, ORG, { api });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET /api/orgs/${ORG}`, `GET /api/orgs/${ORG}/rails/solana`, `POST /api/orgs/${ORG}/rails/solana/revoke`]);
    expect(calls[2]?.body).toEqual({});
    const [sent] = fake.sent;
    if (sent === undefined) throw new Error('unreachable');
    expect(sent.chain).toBe('solana:mainnet');
    expect(submission.signature).toBe(base58Encode(sent.signature));
    expect(submission.txUrl).toBe(`https://explorer.solana.com/tx/${submission.signature}`);
    const signed = readSolanaTransaction(sent.wire);
    expect(signed.instructions).toEqual([{ program: TOKEN_PROGRAM, accounts: [await associatedTokenAddress(fake.address, MINT), fake.address], data: new Uint8Array([5]) }]);
    expect(await fake.verify(signed.message, sent.signature)).toBe(true);
  });

  it('opens no wallet that holds another account than the organisation’s', async () => {
    const { fake, connection } = await connected();
    const { api, calls } = server(STRANGER);
    const error = await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api }));
    expect(error.code).toBe('wrong_account');
    expect(error.message).toContain(STRANGER);
    expect((await failure(revokeSolanaDelegate(connection, ORG, { api }))).code).toBe('wrong_account');
    // Nothing was asked of the server that prepares a transaction, and nothing of the wallet.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(fake.sent).toEqual([]);
  });

  it('signs nothing but what was asked for, whatever the server prepared', async () => {
    const { fake, connection } = await connected();
    const more = server(fake.address, { tamper: (amount) => amount * 1_000n });
    expect((await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api: more.api }))).code).toBe('unexpected_request');

    // The transaction approves another delegate than the rail and the profile name.
    const otherDelegate = server(fake.address, { builtDelegate: STRANGER });
    expect((await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api: otherDelegate.api }))).code).toBe('unexpected_request');

    const otherSigner = server(fake.address, { builtFor: STRANGER });
    expect((await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api: otherSigner.api }))).code).toBe('unexpected_request');
    expect((await failure(revokeSolanaDelegate(connection, ORG, { api: otherSigner.api }))).code).toBe('unexpected_request');

    // The rail names a delegate, or a wallet, that the organisation's own profile does not: no transaction is even asked for.
    for (const contradicting of [server(fake.address, { delegate: STRANGER, serviceKey: DELEGATE }), server(fake.address, { serviceKey: null }), server(fake.address, { profileOwner: STRANGER })]) {
      const refused = await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api: contradicting.api }));
      expect({ code: refused.code, message: refused.message }).toEqual({ code: 'unexpected_request', message: 'the rail names another wallet or another service key than the organisation’s own; nothing was signed' });
      expect((await failure(revokeSolanaDelegate(connection, ORG, { api: contradicting.api }))).code).toBe('unexpected_request');
      expect(contradicting.calls.every((call) => call.method === 'GET')).toBe(true);
    }

    // What is prepared is no transaction at all.
    const honest = server(fake.address);
    const text = createApi({
      fetch: async (input, init) => (init?.method === 'POST' ? Response.json({ transaction: 'not base64 at all!', summary: {}, lastValidBlockHeight: '1' }) : honest.serve(input, init)),
    });
    expect((await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api: text }))).code).toBe('unexpected_request');
    expect((await failure(approveSolanaDelegate(connection, ORG, 0n, { api: honest.api }))).code).toBe('invalid_argument');
    expect(fake.sent).toEqual([]);
  });

  it('hands the wallet no transaction that is for another account to sign', async () => {
    const { fake, connection } = await connected();
    const foreign = bytesOf((await approval(STRANGER, 1_000_000n)).transaction);
    const error = await failure(connection.signAndSend(foreign, 'solana:devnet'));
    expect(error.code).toBe('wrong_account');
    expect((await failure(connection.signAndSend(new TextEncoder().encode('not a transaction'), 'solana:devnet'))).code).toBe('invalid_argument');
    expect(fake.sent).toEqual([]);
  });

  it('passes on what the server says when it will not prepare a transaction', async () => {
    const { fake, connection } = await connected();
    const { api } = server(fake.address, { delegate: null });
    expect(await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api }))).toMatchObject({ status: 409, code: 'refused', message: 'the organisation has no Solana service key' });
    expect(fake.sent).toEqual([]);
  });

  it('says when the treasurer declined, and when the wallet cannot do what is needed', async () => {
    const { fake, connection } = await connected();
    const { api } = server(fake.address);
    fake.failNext = { code: 4001, message: 'User rejected the request.' };
    expect(await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api }))).toMatchObject({ code: 'wallet_rejected', message: 'signing the transaction was declined in the wallet' });
    fake.failNext = { message: 'Transaction simulation failed: Blockhash not found' };
    expect((await failure(approveSolanaDelegate(connection, ORG, 1_000_000n, { api }))).code).toBe('wallet_failed');
    expect(fake.sent).toEqual([]);

    // A wallet on mainnet alone is not asked to send to devnet.
    const mainnetOnly = await connected({ name: 'Mainnet Only', chains: ['solana:mainnet'] });
    const wrongChain = await failure(approveSolanaDelegate(mainnetOnly.connection, ORG, 1_000_000n, { api: server(mainnetOnly.fake.address).api }));
    expect({ code: wrongChain.code, message: wrongChain.message }).toEqual({ code: 'wallet_unavailable', message: 'the account in Mainnet Only is not on solana:devnet' });

    // The server builds version 0 transactions; a wallet that signs only the older kind is told apart before it is opened.
    const legacyOnly = await connected({ name: 'Legacy Only', versions: ['legacy'] });
    const wrongVersion = await failure(approveSolanaDelegate(legacyOnly.connection, ORG, 1_000_000n, { api: server(legacyOnly.fake.address).api }));
    expect({ code: wrongVersion.code, message: wrongVersion.message }).toEqual({ code: 'wallet_unavailable', message: 'Legacy Only does not sign version 0 transactions' });
    expect([mainnetOnly.fake.sent, legacyOnly.fake.sent]).toEqual([[], []]);
  });

  it('confirms by reading the allowance from the server until the chain shows it', async () => {
    const { fake } = await connected();
    let remaining = '0';
    const { api, calls } = server(fake.address, { allowance: () => remaining });
    const pauses: number[] = [];
    const sleep = async (ms: number) => {
      pauses.push(ms);
      if (pauses.length === 2) remaining = '25000000';
    };

    const rail = await waitForSolanaAllowance(ORG, 25_000_000n, { api, sleep, intervalMs: 1_500 });
    expect(rail.allowance).toMatchObject({ status: 'ok', value: { remaining: '25000000' } });
    expect(pauses).toEqual([1_500, 1_500]);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(Array(3).fill(`GET /api/orgs/${ORG}/rails/solana`));

    // After a revocation the allowance to wait for is zero.
    remaining = '0';
    expect((await waitForSolanaAllowance(ORG, 0n, { api, sleep: async () => undefined })).allowance).toMatchObject({ value: { remaining: '0' } });
  });

  it('gives up after the attempts it was allowed, and says that this is not a failure of the transaction', async () => {
    const { fake } = await connected();
    const { api, calls } = server(fake.address, { allowance: () => '7' });
    const error = await failure(waitForSolanaAllowance(ORG, 25_000_000n, { api, attempts: 4, sleep: async () => undefined }));
    expect({ code: error.code, status: error.status, message: error.message }).toEqual({ code: 'not_confirmed', status: null, message: 'the chain does not show an allowance of 25000000 yet' });
    expect(error.details).toEqual({ allowance: { status: 'ok', source: 'solana', readAt: 1, value: { remaining: '7' } } });
    expect(calls).toHaveLength(4);

    const controller = new AbortController();
    const stopped = await failure(waitForSolanaAllowance(ORG, 25_000_000n, { api, signal: controller.signal, sleep: async () => controller.abort() }));
    expect(stopped.code).toBe('aborted');
  });
});
