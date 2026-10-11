import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProof } from '../scripts/proof';

/**
 * The live proof: SOLANA_DEVNET=1 pnpm --filter @holdfast/solana test
 * It spends devnet SOL from the keys in scripts/out/keys.json and takes a few minutes.
 */
const enabled = process.env.SOLANA_DEVNET === '1';
const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const keysFile = fileURLToPath(new URL('../scripts/out/keys.json', import.meta.url));
const MARKER_TAKEN = /^instruction 2 failed: custom program error 0x0 \(System program: AccountAlreadyInUse\)$/;

describe.skipIf(!enabled)('payout rail against a live cluster', () => {
  it('pays a run once, reconciles it, and is refused beyond its limits and after a revoke', { timeout: 900_000 }, async () => {
    const report = await runProof({ rpcUrl, keysFile });
    const { marker } = report;

    expect(report.remainingAfterApproval).toBe(10_000_000n);
    expect(report.priced).toMatchObject({ ok: true, alreadyPaid: false, spent: false, paidBy: null, lineMemos: true });
    expect(report.priced.cost).toMatchObject({ newTokenAccounts: 3, markerLamports: marker.rent, feeLamports: 5_000n });
    expect(report.refusedOverAccountLimit).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(report.refusedOverAccountLimit.cost?.newTokenAccounts).toBe(4);

    // Lamports sent to the marker's address by another key neither set the marker nor hold the run up.
    expect(report.allocationByAnotherKey.error).toBe('instruction 0 failed: MissingRequiredSignature');
    expect(report.allocationUnderOwnBase.error).toBe(
      'instruction 0 failed: custom program error 0x5 (System program: AddressWithSeedMismatch)',
    );
    expect(report.pricedAfterPrefunding).toMatchObject({ ok: true, alreadyPaid: false, spent: false });
    expect(report.pricedAfterPrefunding.cost?.markerLamports).toBe(marker.rent - marker.prefunded);

    expect(report.payout).toMatchObject({ ok: true, outcome: 'paid', error: null, replayed: false, lineMemos: true });
    expect(report.payout.cost).toEqual(report.pricedAfterPrefunding.cost);
    expect(report.payoutSpent).toBe(
      (report.payout.cost?.rentLamports ?? 0n) + marker.rent - marker.prefunded + 5_000n,
    );
    expect(report.remainingAfterRun).toBe(5_750_000n);
    expect(marker.afterPayout).toMatchObject({ exists: true, lamports: marker.rent, space: 1 });

    expect(report.run.signature).toBe(report.payout.tx);
    expect(report.run.total).toBe(4_250_000n);
    expect(report.run.transfers.map(({ to, amount, memo }) => ({ to, amount, memo }))).toEqual([
      { to: report.recipients[0], amount: 1_000_000n, memo: 'INV-1041 design retainer' },
      { to: report.recipients[1], amount: 2_500_000n, memo: 'INV-1042 audit milestone 2' },
      { to: report.recipients[2], amount: 750_000n, memo: 'INV-1043 translation' },
    ]);

    expect(report.replay).toMatchObject({ ok: true, outcome: 'paid', tx: report.payout.tx, replayed: true });
    expect(report.replayAfterRestart).toMatchObject({ ok: true, outcome: 'paid', tx: report.payout.tx, replayed: true });
    expect(report.refusedDifferentLines).toMatchObject({ ok: false, outcome: 'refused', tx: null });

    // A second payout of a paid run is refused by the chain, on its way in and once it is there.
    expect(report.repeatProbe.failedOnChain).toBe(true);
    expect(report.repeatProbe.error).toMatch(MARKER_TAKEN);
    expect(report.repeatAtPreflight.custom).toEqual({ index: 2, code: 0 });

    // Nothing empties a marker or takes it away from the System program.
    expect(report.nonceByAnotherKey.error).toBe('instruction 0 failed: InvalidAccountData');
    expect(report.withdrawal.error).toBe('instruction 0 failed: InvalidArgument');
    expect(report.reassignment.error).toBe(
      'instruction 0 failed: custom program error 0x5 (System program: AddressWithSeedMismatch)',
    );
    expect(report.markerAtEnd).toEqual(marker.afterPayout);

    // An allocation only marks a run when the rent comes with it.
    expect(report.unfundedAllocation.left.exists).toBe(false);
    expect(report.underfundedAllocation.error).toMatch(/InsufficientFundsForRent/);

    // Of two payouts of one run sent together, one lands.
    expect(report.race).toHaveLength(2);
    expect(report.race.filter(payout => payout.error === null)).toHaveLength(1);
    expect(report.race.find(payout => payout.error !== null)?.error).toMatch(MARKER_TAKEN);
    expect(report.remainingAfterRace).toBe(5_000_000n);
    expect(report.replayAfterRace).toMatchObject({ ok: true, outcome: 'paid', replayed: true });
    expect(report.replayAfterRace.tx).toBe(report.race.find(payout => payout.error === null)?.signature);

    expect(report.refusedBeforeSending).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(report.refusedBeforeSending.error).toMatch(/^exceeds delegated allowance/);

    expect(report.probe.failedOnChain).toBe(true);
    expect(report.probe.error).toMatch(/custom program error 0x1 \(Token program: InsufficientFunds\)$/);
    expect(report.probeAtNewAddress).toMatchObject({ signature: null, failedOnChain: false });
    expect(report.selfProbe.failedOnChain).toBe(true);

    expect(report.remainingAfterRevoke).toBe(0n);
    expect(report.refusedAfterRevoke).toMatchObject({ ok: false, outcome: 'refused', tx: null });
    expect(report.probeAfterRevoke.failedOnChain).toBe(true);
    expect(report.probeAfterRevoke.error).toMatch(/custom program error 0x4 \(Token program: OwnerMismatch\)$/);
  });
});
