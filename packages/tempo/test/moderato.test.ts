import { describe, expect, it } from 'vitest';
import { runModeratoProof } from '../scripts/proof-flow';
import { runRevocationProof } from '../scripts/revocation-flow';
import { REVOCATION_GAS } from '../src/index';

// Talks to the public Moderato RPC and its faucet. Run with TEMPO_MODERATO=1.
describe.skipIf(process.env.TEMPO_MODERATO !== '1')('Moderato testnet', () => {
  it('authorizes a key, pays with it, shows what it cannot do, and revokes it', async () => {
    const report = await runModeratoProof();
    const withTx = report.rows.filter((row) => row.tx !== null);
    // authorize, 3-line run, findRun, repeated pay, 6 lines, 32 lines, two probes, revoke, second key
    expect(withTx).toHaveLength(10);
    for (const row of withTx) expect(row.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.rows.some((row) => row.result.includes('SpendingLimitExceeded (0x8a9e71ea)'))).toBe(true);
    expect(report.rows.some((row) => row.result.includes('CallNotAllowed (0x576b38b4)'))).toBe(true);
    expect(report.gas.firstTimePayees3).toBeGreaterThan(report.gas.knownPayees6);
    expect(report.gas.knownPayees32).toBeGreaterThan(report.gas.knownPayees6);
  }, 600_000);

  it('has a passkey root that holds nothing take its keys back, with the sponsor paying', async () => {
    const report = await runRevocationProof();
    const withTx = report.rows.filter((row) => row.tx !== null);
    // authorize, revoke, authorize the second key, revoke it
    expect(withTx).toHaveLength(4);
    for (const row of withTx) expect(row.tx).toMatch(/^0x[0-9a-f]{64}$/);
    // A sender's signature made without the fee payer marker is no signature once a fee payer is added.
    expect(report.rows.some((row) => row.result.startsWith('rejected by the node: '))).toBe(true);
    expect(report.rows.some((row) => row.result.includes('signed for the account to pay the fee itself'))).toBe(true);
    // Both fit the gas a revocation is given, with room to spare.
    expect(report.gas.first * 3n).toBeLessThan(REVOCATION_GAS * 2n);
    expect(report.gas.second).toBeLessThanOrEqual(report.gas.first);
    expect(report.sponsorPaid).toBeGreaterThan(0n);
  }, 600_000);
});
