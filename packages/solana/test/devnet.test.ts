import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runProof } from '../scripts/proof';

/**
 * The live proof: SOLANA_DEVNET=1 pnpm --filter @holdfast/solana test
 * It spends devnet SOL from the keys in scripts/out/keys.json and takes about a minute.
 */
const enabled = process.env.SOLANA_DEVNET === '1';
const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const keysFile = fileURLToPath(new URL('../scripts/out/keys.json', import.meta.url));

describe.skipIf(!enabled)('payout rail against a live cluster', () => {
  it('pays a run, reconciles it, and is refused beyond the allowance and after a revoke', { timeout: 600_000 }, async () => {
    const report = await runProof({ rpcUrl, keysFile });

    expect(report.remainingAfterApproval).toBe(10_000_000n);
    expect(report.payout).toMatchObject({ ok: true, error: null, lineMemos: true });
    expect(report.remainingAfterRun).toBe(5_750_000n);

    expect(report.run.signature).toBe(report.payout.tx);
    expect(report.run.total).toBe(4_250_000n);
    expect(report.run.transfers.map(({ to, amount, memo }) => ({ to, amount, memo }))).toEqual([
      { to: report.recipients[0], amount: 1_000_000n, memo: 'INV-1041 design retainer' },
      { to: report.recipients[1], amount: 2_500_000n, memo: 'INV-1042 audit milestone 2' },
      { to: report.recipients[2], amount: 750_000n, memo: 'INV-1043 translation' },
    ]);

    expect(report.refusedBeforeSending).toMatchObject({ ok: false, tx: null });
    expect(report.refusedBeforeSending.error).toMatch(/^exceeds delegated allowance/);

    expect(report.probe.failedOnChain).toBe(true);
    expect(report.probe.error).toMatch(/custom program error 0x1 \(Token program: InsufficientFunds\)$/);
    expect(report.selfProbe.failedOnChain).toBe(true);

    expect(report.remainingAfterRevoke).toBe(0n);
    expect(report.refusedAfterRevoke).toMatchObject({ ok: false, tx: null });
    expect(report.probeAfterRevoke.failedOnChain).toBe(true);
    expect(report.probeAfterRevoke.error).toMatch(/custom program error 0x4 \(Token program: OwnerMismatch\)$/);
  });
});
