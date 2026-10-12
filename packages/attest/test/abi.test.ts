import { toEventSelector, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { readArtifactAbi } from '../scripts/artifact';
import { hedgeAttestorAbi } from '../src/index';

describe('contract ABI', () => {
  const named = (type: string) => hedgeAttestorAbi.filter((item) => item.type === type).map((item) => item.name);

  it('lists the functions, events and errors of the contract', () => {
    expect(named('function').sort()).toEqual([
      'attest',
      'attesterOf',
      'currentSeries',
      'latestSnapshot',
      'opensTreasuryCommitment',
      'removeAttester',
      'seriesEndedAt',
      'setAttester',
      'snapshot',
      'snapshotCount',
      'startSeries',
      'treasuryCommitmentOf',
      'verifyEntry',
    ]);
    expect(named('event').sort()).toEqual(['Attested', 'AttesterRemoved', 'AttesterSet', 'SeriesStarted']);
    expect(named('error').sort()).toEqual([
      'JournalRewritten',
      'JournalRootCountMismatch',
      'JournalShrank',
      'MalformedPrecompileData',
      'NoAttester',
      'NoSnapshots',
      'NotAttester',
      'PrecompileReadFailed',
      'SeriesUnused',
      'UnknownSeries',
      'UnknownSnapshot',
      'ZeroAttester',
      'ZeroPrice',
    ]);
  });

  it('encodes calls and events the way the compiled contract does', () => {
    // Selectors and the event topic as `forge inspect HedgeAttestor methodIdentifiers` and `events` print them.
    const selector = (name: string) => {
      const item = hedgeAttestorAbi.find((entry) => entry.type === 'function' && entry.name === name);
      if (item === undefined || item.type !== 'function') throw new Error(`no function ${name}`);
      return toFunctionSelector(item);
    };
    expect(selector('attest')).toBe('0xb60fc616');
    expect(selector('setAttester')).toBe('0x9daf85ab');
    expect(selector('removeAttester')).toBe('0xa609c4aa');
    expect(selector('startSeries')).toBe('0xd9589e99');
    expect(selector('currentSeries')).toBe('0x27db7f4d');
    expect(selector('seriesEndedAt')).toBe('0x4b9c25f0');
    expect(selector('snapshotCount')).toBe('0x718e7857');
    expect(selector('snapshot')).toBe('0x0480dc88');
    expect(selector('latestSnapshot')).toBe('0xa88a13d2');
    expect(selector('verifyEntry')).toBe('0x537e5247');

    const topic = (name: string) => {
      const item = hedgeAttestorAbi.find((entry) => entry.type === 'event' && entry.name === name);
      if (item === undefined || item.type !== 'event') throw new Error(`no event ${name}`);
      return toEventSelector(item);
    };
    expect(topic('Attested')).toBe('0xc9016496ac4bef74963868f42b6d57e11186fe18b99949b6cc2c86f856ea3d86');
    expect(topic('SeriesStarted')).toBe('0xb72ec7ebca8335c48a7b4b8883e968f6cd61f8dc3936501ea32543469fa997ba');
  });

  // contracts/out is a build product and is not kept in the repository, so this runs after `forge build`.
  const built = readArtifactAbi();
  it.skipIf(built === null)('is the ABI of the current forge build', () => {
    expect(hedgeAttestorAbi).toEqual(built);
  });
});
