import type { Cluster, ProofReport } from './proof';

export function explorerUrl(cluster: Cluster, rpcUrl: string, signature: string): string {
  const query = cluster === 'devnet' ? 'cluster=devnet' : `cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `https://explorer.solana.com/tx/${signature}?${query}`;
}

const LOCALNET_NOTICE =
  'This is a local validator, not devnet: the signatures exist only there and the links only resolve while it runs.';

export function renderProof(report: ProofReport, startedAt: Date): string {
  const link = (signature: string): string => explorerUrl(report.cluster, report.rpcUrl, signature);
  const lines = [
    `# Solana payout rail: ${report.cluster} proof`,
    '',
    `Run at ${startedAt.toISOString()} against ${report.rpcUrl} (${report.cluster}, node ${report.nodeVersion}).`,
    ...(report.cluster === 'localnet' ? ['', LOCALNET_NOTICE] : []),
    '',
    '| Role | Address |',
    '| --- | --- |',
    `| Owner (team wallet) | \`${report.owner}\` |`,
    `| Delegate (service key, fee payer) | \`${report.delegate}\` |`,
    `| Test mint (6 decimals) | \`${report.mint}\` |`,
    `| Owner token account | \`${report.ownerTokenAccount}\` |`,
    ...report.recipients.map((recipient, index) => `| Recipient ${index + 1} | \`${recipient}\` |`),
    '',
    '## Steps',
    '',
  ];
  for (const [index, step] of report.steps.entries()) {
    lines.push(`${index + 1}. **${step.title}**`);
    if (step.signature) lines.push(`   - [\`${step.signature}\`](${link(step.signature)})`);
    lines.push(...step.notes.map(note => `   - ${note}`), '');
  }
  return `${lines.join('\n')}\n`;
}
