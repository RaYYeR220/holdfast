import { createHash } from 'node:crypto';
import {
  createNoopSigner,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  isSignerRole,
  lamports,
  type Address,
  type MaybeEncodedAccount,
} from '@solana/kit';
import {
  parseAllocateWithSeedInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { describe, expect, it } from 'vitest';
import {
  isMarkerSet,
  MARKER_INSTRUCTION_INDEX,
  MARKER_SEED_LENGTH,
  MARKER_SPACE,
  markerInstructions,
  markerShortfall,
  runMarker,
  runMarkerSeed,
} from '../src/marker';
import { payoutInstructions } from '../src/payout';
import { addressOf } from './fake-node';
import { planOf } from './fixtures';

const OWNER = addressOf(20);
const MINT = addressOf(21);
const DELEGATE = addressOf(1);
const RUN_ID = 'HF-2026-10-0001';
const sha256 = (...parts: (Uint8Array | string)[]): Uint8Array => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const bytesOf = (address: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(address));

describe('runMarkerSeed', () => {
  it('is the leading 32 base58 characters of a hash over the team wallet, the mint and the run id', async () => {
    const digest = sha256('holdfast run marker 1', bytesOf(OWNER), bytesOf(MINT), RUN_ID);
    const seed = await runMarkerSeed(OWNER, MINT, RUN_ID);
    expect(seed).toBe(getBase58Decoder().decode(digest).slice(0, 32));
    expect(seed).toHaveLength(MARKER_SEED_LENGTH);
  });

  // A seed that came out differently would leave every run paid so far without a marker.
  it('does not change from one build to the next', async () => {
    expect(await runMarkerSeed(OWNER, MINT, RUN_ID)).toBe('912D3mphwW3t43FXNQkoCKXQmFDzoJCn');
  });

  it('differs when the run id, the team wallet or the mint does', async () => {
    const seeds = await Promise.all([
      runMarkerSeed(OWNER, MINT, RUN_ID),
      runMarkerSeed(OWNER, MINT, 'HF-2026-10-0002'),
      runMarkerSeed(MINT, OWNER, RUN_ID),
      runMarkerSeed(OWNER, addressOf(22), RUN_ID),
      runMarkerSeed(addressOf(23), MINT, RUN_ID),
    ]);
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('is as long for a long run id as for a short one', async () => {
    for (const runId of ['a', 'x'.repeat(64), 'été 2026']) {
      expect(await runMarkerSeed(OWNER, MINT, runId)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32}$/);
    }
  });
});

describe('runMarker', () => {
  it('is the address the System program derives from the service key and the seed, for itself as owner', async () => {
    const seed = await runMarkerSeed(OWNER, MINT, RUN_ID);
    const expected = getAddressDecoder().decode(sha256(bytesOf(DELEGATE), seed, bytesOf(SYSTEM_PROGRAM_ADDRESS)));
    expect(await runMarker(DELEGATE, seed)).toEqual({ address: expected, seed });
  });

  it('is another address under another service key', async () => {
    const seed = await runMarkerSeed(OWNER, MINT, RUN_ID);
    expect((await runMarker(addressOf(2), seed)).address).not.toBe((await runMarker(DELEGATE, seed)).address);
  });
});

describe('isMarkerSet', () => {
  const account = (programAddress: Address, space: number): MaybeEncodedAccount => ({
    exists: true,
    address: addressOf(4),
    data: new Uint8Array(space),
    executable: false,
    lamports: lamports(897_840n),
    programAddress,
    space: BigInt(space),
  });

  it('holds for a System-owned account that carries data', () => {
    expect(isMarkerSet(account(SYSTEM_PROGRAM_ADDRESS, MARKER_SPACE))).toBe(true);
  });

  it('does not hold for an address that only holds lamports, which anybody can send', () => {
    expect(isMarkerSet(account(SYSTEM_PROGRAM_ADDRESS, 0))).toBe(false);
  });

  it('does not hold for an account that does not exist or that another program owns', () => {
    expect(isMarkerSet({ exists: false, address: addressOf(4) })).toBe(false);
    expect(isMarkerSet(undefined)).toBe(false);
    expect(isMarkerSet(account(TOKEN_PROGRAM_ADDRESS, 165))).toBe(false);
  });
});

describe('markerShortfall', () => {
  const RENT = 897_840n;

  it('is the whole rent for an address that holds nothing', () => {
    expect(markerShortfall(0n, RENT)).toBe(RENT);
  });

  it('is what is missing when somebody has sent lamports there', () => {
    expect(markerShortfall(890_880n, RENT)).toBe(6_960n);
    expect(markerShortfall(RENT - 1n, RENT)).toBe(1n);
  });

  it('is one lamport, never nothing, for an address that already holds the rent or more', () => {
    expect(markerShortfall(RENT, RENT)).toBe(1n);
    expect(markerShortfall(50n * RENT, RENT)).toBe(1n);
  });
});

describe('markerInstructions', () => {
  const marker = { address: addressOf(4), seed: 's'.repeat(32) };
  function parsedInstructions() {
    const [fund, allocate] = markerInstructions(createNoopSigner(DELEGATE), marker, 897_840n);
    if (!fund?.accounts || !fund.data || !allocate?.accounts || !allocate.data) throw new Error('two instructions');
    return {
      fund: parseTransferSolInstruction({ ...fund, accounts: fund.accounts, data: fund.data }),
      allocate: parseAllocateWithSeedInstruction({ ...allocate, accounts: allocate.accounts, data: allocate.data }),
    };
  }

  it('are two and no more', () => {
    expect(markerInstructions(createNoopSigner(DELEGATE), marker, 897_840n)).toHaveLength(2);
  });

  it('send the lamports from the service key to the marker', () => {
    const { accounts, data } = parsedInstructions().fund;
    expect(accounts.source.address).toBe(DELEGATE);
    expect(accounts.destination.address).toBe(marker.address);
    expect(data.amount).toBe(897_840n);
  });

  it('give the marker one byte, with the service key signing as the base of its address', () => {
    const parsed = parsedInstructions().allocate;
    expect(parsed.accounts.newAccount.address).toBe(marker.address);
    expect(parsed.accounts.baseAccount.address).toBe(DELEGATE);
    expect(isSignerRole(parsed.accounts.baseAccount.role)).toBe(true);
    expect(isSignerRole(parsed.accounts.newAccount.role)).toBe(false);
    expect(parsed.data).toMatchObject({
      base: DELEGATE,
      seed: marker.seed,
      space: 1n,
      programAddress: SYSTEM_PROGRAM_ADDRESS,
    });
  });

  it('come before every transfer of a payout, with the allocation where a failure is read as already paid', () => {
    const instructions = payoutInstructions(planOf([{ create: true }, {}]));
    const programs = instructions.map(instruction => instruction.programAddress);
    expect(programs.indexOf(SYSTEM_PROGRAM_ADDRESS)).toBe(MARKER_INSTRUCTION_INDEX - 1);
    expect(programs.lastIndexOf(SYSTEM_PROGRAM_ADDRESS)).toBe(MARKER_INSTRUCTION_INDEX);
    expect(programs.indexOf(TOKEN_PROGRAM_ADDRESS)).toBeGreaterThan(MARKER_INSTRUCTION_INDEX);
  });
});
