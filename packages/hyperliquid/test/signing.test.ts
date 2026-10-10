import { HttpTransport } from '@nktkas/hyperliquid';
import { ApproveAgentTypes, order as sdkOrder, UserSetAbstractionTypes } from '@nktkas/hyperliquid/api/exchange';
import { createL1ActionHash, signL1Action, signUserSignedAction } from '@nktkas/hyperliquid/signing';
import { recoverTypedDataAddress, verifyTypedData } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentSetAbstraction,
  approveAgentAction,
  cloidFor,
  createHedgeVenue,
  generateAgentKey,
  HyperliquidError,
  submitApproveAgent,
  submitUserSetAbstraction,
  toWireSignature,
  type TypedData,
  userSetAbstractionAction,
} from '../src/index';
import { iocOrderAction } from '../src/orders';
import { agentAccount, signL1 } from '../src/signing';
import { type Body, fakeHyperliquid, fixtures, json, ZEC_ASSET } from './support';

const NONCE = 1_791_636_000_000;
const AGENT = '0xf8ae48bcbe12fcc9a923c963eebe4a98cbb14c18';
/** The key Hyperliquid's own Python SDK signs its published test vectors with. */
const VECTOR_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

const master = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

/** What a browser wallet does with the typed data. */
const walletSign = (account: typeof master, typedData: TypedData) => account.signTypedData(typedData);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('approveAgent', () => {
  const params = { agentAddress: AGENT, agentName: 'holdfast', network: 'mainnet', nonce: NONCE } as const;

  it('builds the typed data and the request body Hyperliquid expects', () => {
    expect(approveAgentAction(params)).toEqual({
      typedData: {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42_161,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: { hyperliquidChain: 'Mainnet', agentAddress: AGENT, agentName: 'holdfast', nonce: NONCE },
      },
      body: {
        action: {
          type: 'approveAgent',
          signatureChainId: '0xa4b1',
          hyperliquidChain: 'Mainnet',
          agentAddress: AGENT,
          agentName: 'holdfast',
          nonce: NONCE,
        },
        nonce: NONCE,
      },
    });
  });

  it('uses the layout of the SDK it was checked against', () => {
    const { typedData } = approveAgentAction(params);
    expect(typedData.types).toEqual(ApproveAgentTypes);
  });

  it('names the testnet chain, and takes the chain the wallet is on', () => {
    const testnet = approveAgentAction({ ...params, network: 'testnet' });
    expect(testnet.typedData.domain.chainId).toBe(421_614);
    expect(testnet.typedData.message.hyperliquidChain).toBe('Testnet');
    expect(testnet.body.action).toMatchObject({ signatureChainId: '0x66eee', hyperliquidChain: 'Testnet' });

    const onEthereum = approveAgentAction({ ...params, signatureChainId: 1 });
    expect(onEthereum.typedData.domain.chainId).toBe(1);
    expect(onEthereum.body.action.signatureChainId).toBe('0x1');
  });

  it('lowercases the agent address and can put an expiry on the approval', () => {
    const request = approveAgentAction({ ...params, agentAddress: AGENT.toUpperCase().replace('0X', '0x'), validUntil: NONCE + 86_400_000 });
    expect(request.body.action.agentAddress).toBe(AGENT);
    expect(request.body.action.agentName).toBe(`holdfast valid_until ${NONCE + 86_400_000}`);
    expect(request.typedData.message.agentName).toBe(request.body.action.agentName);
  });

  it('validates its parameters', () => {
    const bad = [
      { agentName: '' },
      { agentName: 'seventeen-letters' },
      { agentName: 'x valid_until 1' },
      { agentAddress: '0x1234' },
      { nonce: 0 },
      { nonce: 1.5 },
      { signatureChainId: 0 },
      { validUntil: NONCE },
    ];
    for (const overrides of bad) {
      expect(() => approveAgentAction({ ...params, ...overrides }), JSON.stringify(overrides)).toThrow(HyperliquidError);
    }
  });

  it('produces typed data a wallet can sign and that verifies to the signer', async () => {
    const { typedData } = approveAgentAction(params);
    const signature = await walletSign(master, typedData);
    expect(await verifyTypedData({ ...typedData, address: master.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...typedData, address: stranger.address, signature })).toBe(false);
    expect(await recoverTypedDataAddress({ ...typedData, signature })).toBe(master.address);
  });

  it('signs to the same bytes as the SDK signing the request body itself', async () => {
    const request = approveAgentAction(params);
    const ours = toWireSignature(await walletSign(master, request.typedData));
    const theirs = await signUserSignedAction({ wallet: master, action: request.body.action, types: ApproveAgentTypes });
    expect(ours).toEqual(theirs);
  });

  it('submits the action, the nonce and the split signature', async () => {
    const server = fakeHyperliquid({ exchange: () => ({ status: 'ok', response: { type: 'default' } }) });
    const request = approveAgentAction(params);
    const signature = await walletSign(master, request.typedData);
    const reply = await submitApproveAgent({ ...params, user: master.address, signature, fetch: server.fetch });

    expect(reply).toEqual({
      ok: true,
      delivered: true,
      httpStatus: 200,
      response: { status: 'ok', response: { type: 'default' } },
      error: null,
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe('https://api.hyperliquid.xyz/exchange');
    expect(server.calls[0]?.body).toEqual({ ...request.body, signature: toWireSignature(signature) });
  });

  it('hands back the refusal an unfunded account gets, word for word', async () => {
    // Recorded on testnet on 2026-10-10 with a throwaway key that had never deposited.
    const refusal = {
      status: 'err',
      response: `Must deposit before performing actions. User: ${master.address.toLowerCase()}`,
    };
    const server = fakeHyperliquid({ exchange: () => refusal });
    const testnet = { ...params, network: 'testnet' } as const;
    const signature = await walletSign(master, approveAgentAction(testnet).typedData);
    const reply = await submitApproveAgent({ ...testnet, user: master.address, signature, fetch: server.fetch });

    expect(reply).toEqual({ ok: false, delivered: true, httpStatus: 200, response: refusal, error: refusal.response });
    expect(server.calls[0]?.url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
  });

  it('does not send a signature made by another account', async () => {
    const server = fakeHyperliquid({});
    const signature = await walletSign(stranger, approveAgentAction(params).typedData);
    const reply = await submitApproveAgent({ ...params, user: master.address, signature, fetch: server.fetch });
    expect(reply).toMatchObject({ ok: false, delivered: false, httpStatus: null, response: null });
    expect(reply.error).toContain(`signed by ${stranger.address.toLowerCase()}`);
    expect(server.calls).toHaveLength(0);
  });

  it('does not send a signature that was made over different parameters', async () => {
    const server = fakeHyperliquid({});
    const signature = await walletSign(master, approveAgentAction(params).typedData);
    const swapped = { ...params, agentAddress: stranger.address };
    const reply = await submitApproveAgent({ ...swapped, user: master.address, signature, fetch: server.fetch });
    expect(reply).toMatchObject({ ok: false, delivered: false });
    expect(server.calls).toHaveLength(0);
  });

  it('does not send a malformed signature', async () => {
    const server = fakeHyperliquid({});
    for (const signature of ['0x1234', 'nonsense', `0x${'00'.repeat(65)}`]) {
      const reply = await submitApproveAgent({ ...params, user: master.address, signature, fetch: server.fetch });
      expect(reply, signature).toMatchObject({ ok: false, delivered: false });
      expect(reply.error).toContain('not sent');
    }
    expect(server.calls).toHaveLength(0);
  });

  it('reports a dropped connection without throwing', async () => {
    const signature = await walletSign(master, approveAgentAction(params).typedData);
    const reply = await submitApproveAgent({
      ...params,
      user: master.address,
      signature,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(reply).toEqual({ ok: false, delivered: false, httpStatus: null, response: null, error: 'request failed: fetch failed' });
  });
});

describe('userSetAbstraction', () => {
  const params = { user: master.address, abstraction: 'unifiedAccount', network: 'mainnet', nonce: NONCE } as const;
  const user = master.address.toLowerCase();

  it('builds the typed data and the request body Hyperliquid expects', () => {
    const request = userSetAbstractionAction(params);
    expect(request).toEqual({
      typedData: {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42_161,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          'HyperliquidTransaction:UserSetAbstraction': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'user', type: 'address' },
            { name: 'abstraction', type: 'string' },
            { name: 'nonce', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:UserSetAbstraction',
        message: { hyperliquidChain: 'Mainnet', user, abstraction: 'unifiedAccount', nonce: NONCE },
      },
      body: {
        action: {
          type: 'userSetAbstraction',
          signatureChainId: '0xa4b1',
          hyperliquidChain: 'Mainnet',
          user,
          abstraction: 'unifiedAccount',
          nonce: NONCE,
        },
        nonce: NONCE,
      },
    });
    expect(request.typedData.types).toEqual(UserSetAbstractionTypes);
  });

  it('verifies to the signer and matches the SDK signing the request body', async () => {
    const request = userSetAbstractionAction({ ...params, abstraction: 'disabled' });
    const signature = await walletSign(master, request.typedData);
    expect(await verifyTypedData({ ...request.typedData, address: master.address, signature })).toBe(true);
    const theirs = await signUserSignedAction({ wallet: master, action: request.body.action, types: UserSetAbstractionTypes });
    expect(toWireSignature(signature)).toEqual(theirs);
  });

  it('submits only when the account itself signed', async () => {
    const server = fakeHyperliquid({ exchange: () => ({ status: 'ok', response: { type: 'default' } }) });
    const request = userSetAbstractionAction(params);

    const foreign = await walletSign(stranger, request.typedData);
    expect(await submitUserSetAbstraction({ ...params, signature: foreign, fetch: server.fetch })).toMatchObject({
      ok: false,
      delivered: false,
    });
    expect(server.calls).toHaveLength(0);

    const signature = await walletSign(master, request.typedData);
    expect(await submitUserSetAbstraction({ ...params, signature, fetch: server.fetch })).toMatchObject({ ok: true });
    expect(server.calls[0]?.body).toEqual({ ...request.body, signature: toWireSignature(signature) });
  });
});

describe('agentSetAbstraction', () => {
  it('signs the L1 action with the agent key, exactly as the SDK would', async () => {
    const agent = generateAgentKey();
    const server = fakeHyperliquid({ exchange: () => ({ status: 'ok', response: { type: 'default' } }) });
    const reply = await agentSetAbstraction({
      agentPrivateKey: agent.privateKey,
      abstraction: 'unifiedAccount',
      network: 'testnet',
      fetch: server.fetch,
      now: () => NONCE,
    });
    expect(reply.ok).toBe(true);

    const action = { type: 'agentSetAbstraction', abstraction: 'u' };
    const signature = await signL1Action({ wallet: privateKeyToAccount(agent.privateKey), action, nonce: NONCE, isTestnet: true });
    expect(server.calls[0]?.url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(server.calls[0]?.body).toEqual({ action, nonce: NONCE, signature });
  });

  it('writes "disabled" as the code Hyperliquid uses for it', async () => {
    const server = fakeHyperliquid({ exchange: () => ({ status: 'ok', response: { type: 'default' } }) });
    await agentSetAbstraction({
      agentPrivateKey: generateAgentKey().privateKey,
      abstraction: 'disabled',
      network: 'mainnet',
      fetch: server.fetch,
    });
    expect(server.calls[0]?.body.action).toEqual({ type: 'agentSetAbstraction', abstraction: 'i' });
  });

  it('returns the refusal an unknown key gets instead of throwing', async () => {
    // Recorded on testnet on 2026-10-10 with a key no account had approved.
    const agent = generateAgentKey();
    const refusal = { status: 'err', response: `User or API Wallet ${agent.address} does not exist.` };
    const server = fakeHyperliquid({ exchange: () => refusal });
    const reply = await agentSetAbstraction({
      agentPrivateKey: agent.privateKey,
      abstraction: 'unifiedAccount',
      network: 'testnet',
      fetch: server.fetch,
    });
    expect(reply).toMatchObject({ ok: false, delivered: true, response: refusal, error: refusal.response });
  });
});

describe('order signing', () => {
  const USER = '0x54ba65bcbfaa7f2c3c53e41e8092159f351ec5e5';
  const agent = generateAgentKey();
  const account = privateKeyToAccount(agent.privateKey);
  const cloid = cloidFor('org_1', 100, 0);

  async function placedBody(network: 'mainnet' | 'testnet') {
    const server = fakeHyperliquid({
      info: {
        metaAndAssetCtxs: () => fixtures.market,
        userRole: () => ({ role: 'agent', data: { user: USER } }),
        orderStatus: () => ({ status: 'unknownOid' }),
      },
      exchange: () => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.5', avgPx: '1223.9', oid: 1 } }] } } }),
    });
    const venue = createHedgeVenue({ network, agentPrivateKey: agent.privateKey, fetch: server.fetch, now: () => NONCE });
    await venue.place({ user: USER, side: 'sell', lots: 150, limitPx: 1223.9, reduceOnly: false, cloid });
    const body = server.sent('exchange')[0]?.body;
    if (body === undefined) throw new Error('no order was sent');
    return body;
  }

  it('reproduces the signatures published with the Hyperliquid Python SDK', async () => {
    const vectorAccount = agentAccount(VECTOR_KEY);
    const gtcOrder = { a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } };
    const action = { type: 'order', orders: [gtcOrder], grouping: 'na' };
    expect(await signL1(vectorAccount, 'mainnet', action, 0)).toEqual({
      r: '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e',
      s: '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e',
      v: 28,
    });
    expect(await signL1(vectorAccount, 'testnet', action, 0)).toEqual({
      r: '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54',
      s: '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5',
      v: 27,
    });

    const withCloid = { type: 'order', orders: [{ ...gtcOrder, c: '0x00000000000000000000000000000001' }], grouping: 'na' };
    expect(await signL1(vectorAccount, 'mainnet', withCloid, 0)).toEqual({
      r: '0x041ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3',
      s: '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da',
      v: 27,
    });
  });

  it('hashes an IOC order to the connection id published with the Python SDK', () => {
    const action = iocOrderAction({ asset: 4, isBuy: true, px: '1670.1', size: '0.0147', reduceOnly: false });
    expect(createL1ActionHash({ action, nonce: 1_677_777_606_040 })).toBe(
      '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908',
    );
  });

  it('strips the trailing zeros Hyperliquid drops before hashing', () => {
    const plain = iocOrderAction({ asset: 4, isBuy: true, px: '1670.1', size: '0.0147', reduceOnly: false });
    const padded = iocOrderAction({ asset: 4, isBuy: true, px: '1670.10', size: '0.014700', reduceOnly: false });
    expect(JSON.stringify(padded)).toBe(JSON.stringify(plain));
    expect(iocOrderAction({ asset: 0, isBuy: false, px: '1200.0', size: '10.00', reduceOnly: true })).toMatchObject({
      orders: [{ p: '1200', s: '10' }],
    });
  });

  it('matches the SDK signing function for the same action, on both networks', async () => {
    const expected = {
      type: 'order',
      orders: [{ a: ZEC_ASSET, b: false, p: '1223.9', s: '1.5', r: false, t: { limit: { tif: 'Ioc' } }, c: cloid }],
      grouping: 'na',
    };
    for (const network of ['mainnet', 'testnet'] as const) {
      const body = await placedBody(network);
      expect(JSON.stringify(body.action)).toBe(JSON.stringify(expected));
      expect(body.nonce).toBe(NONCE);
      expect(body.signature).toEqual(
        await signL1Action({ wallet: account, action: expected, nonce: NONCE, isTestnet: network === 'testnet' }),
      );
    }
    expect((await placedBody('mainnet')).signature).not.toEqual((await placedBody('testnet')).signature);
  });

  it('sends the same request the SDK order method sends for the same order', async () => {
    const sdkBodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      sdkBodies.push(JSON.parse(String(init?.body)));
      return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '1.5', avgPx: '1223.9', oid: 1 } }] } } });
    });
    await sdkOrder(
      { transport: new HttpTransport(), wallet: account, nonceManager: () => NONCE },
      // Deliberately untidy input: the SDK normalises it, and the result must be what we send.
      { orders: [{ a: ZEC_ASSET, b: false, p: 1223.9, s: '1.50', r: false, t: { limit: { tif: 'Ioc' } }, c: cloid.toUpperCase().replace('0X', '0x') as `0x${string}` }], grouping: 'na' },
    );
    vi.unstubAllGlobals();

    const ours = await placedBody('mainnet');
    const [theirs] = sdkBodies as Body[];
    expect(sdkBodies).toHaveLength(1);
    // The action is compared as text because its key order is signed; the envelope around it is not.
    expect(JSON.stringify(ours.action)).toBe(JSON.stringify(theirs?.action));
    expect(ours).toEqual(theirs);
  });

  it('verifies as the agent under the phantom-agent scheme', async () => {
    const body = await placedBody('mainnet');
    const { r, s, v } = body.signature as { r: `0x${string}`; s: `0x${string}`; v: number };
    const signer = await recoverTypedDataAddress({
      domain: { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
      types: { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
      primaryType: 'Agent',
      message: { source: 'a', connectionId: createL1ActionHash({ action: body.action, nonce: body.nonce }) },
      signature: { r, s, yParity: v === 27 ? 0 : 1 },
    });
    expect(signer.toLowerCase()).toBe(agent.address);
  });
});

describe('keys and signatures', () => {
  it('generates a fresh agent key with its lowercase address', () => {
    const first = generateAgentKey();
    const second = generateAgentKey();
    expect(first.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.address).toBe(privateKeyToAccount(first.privateKey).address.toLowerCase());
    expect(second.privateKey).not.toBe(first.privateKey);
  });

  it('rejects an agent key that is not 32 bytes of hex', () => {
    for (const key of ['', '0x1234', 'ab'.repeat(32), `0x${'zz'.repeat(32)}`]) {
      expect(() => createHedgeVenue({ network: 'mainnet', agentPrivateKey: key as `0x${string}` }), key).toThrow(HyperliquidError);
    }
  });

  it('splits a wallet signature and normalises the recovery byte to 27 or 28', async () => {
    const { typedData } = approveAgentAction({ agentAddress: AGENT, agentName: 'holdfast', network: 'mainnet', nonce: NONCE });
    const signature = await walletSign(master, typedData);
    const wire = toWireSignature(signature);
    expect(wire.r).toBe(`0x${signature.slice(2, 66)}`);
    expect(wire.s).toBe(`0x${signature.slice(66, 130)}`);
    expect([27, 28]).toContain(wire.v);

    // Some signers put the bare parity bit in the last byte.
    const parity = wire.v === 27 ? '00' : '01';
    expect(toWireSignature(`${signature.slice(0, 130)}${parity}`)).toEqual(wire);
  });

  it('rejects anything that is not a 65-byte signature', () => {
    for (const signature of ['', '0x', '0x1234', `0x${'11'.repeat(64)}`, `0x${'11'.repeat(64)}05`]) {
      expect(() => toWireSignature(signature), signature).toThrow(HyperliquidError);
    }
  });
});
