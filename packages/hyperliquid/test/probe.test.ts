import { UsdSendTypes, Withdraw3Types } from '@nktkas/hyperliquid/api/exchange';
import { signUserSignedAction } from '@nktkas/hyperliquid/signing';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { generateAgentKey, HyperliquidError, probeWithdrawRefusal } from '../src/index';
import { type Body, fakeHyperliquid, json, text } from './support';

const NOW = 1_791_636_767_829;
const USER = '0xf45f5abdde9788de8b575d9c6feb9a557a70f169';
const agent = generateAgentKey();

/**
 * What testnet answered on 2026-10-10 when a throwaway key that no account had
 * approved and that had never deposited signed a withdraw3 and a usdSend.
 */
const refusal = { status: 'err', response: `Must deposit before performing actions. User: ${agent.address}` };

function probe(exchange: (body: Body) => unknown, network: 'mainnet' | 'testnet' = 'testnet') {
  const server = fakeHyperliquid({ exchange });
  const outcome = probeWithdrawRefusal({
    agentPrivateKey: agent.privateKey,
    network,
    user: USER,
    fetch: server.fetch,
    now: () => NOW,
  });
  return { server, outcome };
}

describe('probeWithdrawRefusal', () => {
  it('reports both attempts refused, with the answers as received', async () => {
    const { outcome } = probe(() => refusal);
    expect(await outcome).toEqual({
      agentAddress: agent.address,
      user: USER,
      withdraw3: {
        attempted: {
          type: 'withdraw3',
          signatureChainId: '0x66eee',
          hyperliquidChain: 'Testnet',
          destination: USER,
          amount: '5',
          time: NOW,
        },
        refused: true,
        response: refusal,
        httpStatus: 200,
        error: null,
      },
      usdSend: {
        attempted: {
          type: 'usdSend',
          signatureChainId: '0x66eee',
          hyperliquidChain: 'Testnet',
          destination: USER,
          amount: '5',
          time: NOW + 1,
        },
        refused: true,
        response: refusal,
        httpStatus: 200,
        error: null,
      },
    });
  });

  it('sends a withdrawal and then a transfer, each signed by the agent key', async () => {
    const { server, outcome } = probe(() => refusal, 'mainnet');
    const result = await outcome;

    expect(server.calls.map((call) => [call.url, call.body.action.type])).toEqual([
      ['https://api.hyperliquid.xyz/exchange', 'withdraw3'],
      ['https://api.hyperliquid.xyz/exchange', 'usdSend'],
    ]);
    const account = privateKeyToAccount(agent.privateKey);
    for (const [call, attempt, types] of [
      [server.calls[0], result.withdraw3, Withdraw3Types],
      [server.calls[1], result.usdSend, UsdSendTypes],
    ] as const) {
      expect(call?.body.action).toEqual(attempt.attempted);
      expect(call?.body.action).toMatchObject({ signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', destination: USER });
      expect(call?.body.nonce).toBe(call?.body.action.time);
      expect(call?.body.signature).toEqual(await signUserSignedAction({ wallet: account, action: call?.body.action, types }));
    }
  });

  it('signs so that Hyperliquid sees the agent, not the team, as the one asking', async () => {
    const { server, outcome } = probe(() => refusal);
    await outcome;
    const { action, signature } = server.calls[0]?.body ?? {};
    const signer = await recoverTypedDataAddress({
      domain: {
        name: 'HyperliquidSignTransaction',
        version: '1',
        chainId: 0x66eee,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      },
      types: Withdraw3Types,
      primaryType: 'HyperliquidTransaction:Withdraw',
      message: action,
      signature: { r: signature.r, s: signature.s, yParity: signature.v === 27 ? 0 : 1 },
    });
    expect(signer.toLowerCase()).toBe(agent.address);
    expect(signer.toLowerCase()).not.toBe(USER);
  });

  it('never calls an unanswered request a refusal', async () => {
    const { outcome } = probe(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ETIMEDOUT') });
    });
    const result = await outcome;
    for (const attempt of [result.withdraw3, result.usdSend]) {
      expect(attempt).toMatchObject({
        refused: false,
        response: null,
        httpStatus: null,
        error: 'request failed: fetch failed (connect ETIMEDOUT)',
      });
    }
  });

  it('does not count an HTTP error as a refusal of the action', async () => {
    const answers = [
      text('Failed to deserialize the JSON body into the target type', 422),
      text('rate limited', 429),
      text('Bad Gateway', 502),
      json({ status: 'err', response: 'looks like a refusal but arrived with a 500' }, 500),
    ];
    for (const answer of answers) {
      const { outcome } = probe(() => answer.clone());
      const result = await outcome;
      for (const attempt of [result.withdraw3, result.usdSend]) {
        expect(attempt.refused, String(answer.status)).toBe(false);
        expect(attempt.httpStatus).toBe(answer.status);
        expect(attempt.error).toContain(`HTTP ${answer.status}`);
      }
    }
  });

  it('does not count an unreadable 200 as a refusal', async () => {
    for (const body of [text('<html>maintenance</html>', 200), json(null), json({}), json({ status: 'error' }), json('err')]) {
      const { outcome } = probe(() => body.clone());
      const result = await outcome;
      expect(result.withdraw3.refused).toBe(false);
      expect(result.usdSend.refused).toBe(false);
      expect(result.withdraw3.error).toContain('unexpected response');
    }
  });

  it('says so loudly when Hyperliquid accepts the action', async () => {
    const accepted = { status: 'ok', response: { type: 'default' } };
    const { outcome } = probe(() => accepted);
    const result = await outcome;
    expect(result.withdraw3).toMatchObject({
      refused: false,
      response: accepted,
      error: 'Hyperliquid accepted a withdraw3 signed by the agent key',
    });
    expect(result.usdSend).toMatchObject({
      refused: false,
      response: accepted,
      error: 'Hyperliquid accepted a usdSend signed by the agent key',
    });
  });

  it('judges each attempt on its own answer', async () => {
    const { outcome } = probe((body) => {
      if (body.action.type === 'withdraw3') return refusal;
      throw new TypeError('fetch failed');
    });
    const result = await outcome;
    expect(result.withdraw3).toMatchObject({ refused: true, error: null });
    expect(result.usdSend).toMatchObject({ refused: false, response: null, error: 'request failed: fetch failed' });
  });

  it('asks for the amount it is told to', async () => {
    const server = fakeHyperliquid({ exchange: () => refusal });
    const result = await probeWithdrawRefusal({
      agentPrivateKey: agent.privateKey,
      network: 'testnet',
      user: USER.toUpperCase().replace('0X', '0x'),
      amount: '12.5',
      fetch: server.fetch,
    });
    expect(result.user).toBe(USER);
    expect(result.withdraw3.attempted).toMatchObject({ amount: '12.5', destination: USER });
    expect(result.usdSend.attempted).toMatchObject({ amount: '12.5', destination: USER });
  });

  it('rejects bad parameters before sending anything', async () => {
    const server = fakeHyperliquid({});
    const base = { agentPrivateKey: agent.privateKey, network: 'testnet', user: USER, fetch: server.fetch } as const;
    await expect(probeWithdrawRefusal({ ...base, agentPrivateKey: '0x1234' })).rejects.toBeInstanceOf(HyperliquidError);
    await expect(probeWithdrawRefusal({ ...base, user: 'treasury' })).rejects.toBeInstanceOf(HyperliquidError);
    for (const amount of ['0', '-5', 'all', '1e3', '']) {
      await expect(probeWithdrawRefusal({ ...base, amount }), amount).rejects.toBeInstanceOf(HyperliquidError);
    }
    expect(server.calls).toHaveLength(0);
  });
});
