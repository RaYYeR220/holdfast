import type { AttestationList } from '@/server/attestations/service';
import type { Outcome } from '@/server/pages/treasury-lock-reads';
import { Button, CopyButton, DataTable, ExternalTxLink, Input, KeyValue, Link, Notice, Panel, Select, Timestamp, Unavailable, formatNumber, shorten } from '@/ui';
import { sourceName } from '../overview/OverviewBody';
import type { ProofShown } from './load';
import { type LockParams, castCall, hyperEvmAddressUrl, hyperEvmTxUrl, snapshotText } from './params';
import { formatPx } from './words';

type Snapshots = Outcome<AttestationList>;

function Hash({ value, what }: { value: string; what: string }) {
  return (
    <CopyButton value={value} what={what}>
      {shorten(value, 10, 8)}
    </CopyButton>
  );
}

function ChainTx({ chainId, tx }: { chainId: number | null; tx: string | null }) {
  if (tx === null) return <span className="hf-small">Not sent by this service, so its transaction is not on record here.</span>;
  const href = chainId === null ? null : hyperEvmTxUrl(chainId, tx);
  return href === null ? <Hash value={tx} what="transaction hash" /> : <ExternalTxLink chain="hyperliquid" id={tx} href={href} showChain={false} />;
}

export interface SnapshotViewProps {
  base: string;
  now: number;
  snapshots: Snapshots;
}

/**
 * The snapshots the HedgeAttestor contract holds for the account: for the
 * latest one, the position and the prices the contract read from HyperCore
 * itself, beside the root and the length of the journal the service stated.
 */
export function SnapshotView({ base, now, snapshots }: SnapshotViewProps) {
  const list = snapshots.status === 'ok' ? snapshots.value : null;
  const read = list?.snapshots ?? null;
  const items = read !== null && read.status === 'ok' ? read.value.items : [];
  const latest = items[0];
  const contractUrl = list !== null && list.contract !== null && list.chainId !== null ? hyperEvmAddressUrl(list.chainId, list.contract) : null;

  return (
    <Panel title="Snapshots on HyperEVM" level={2} {...(read !== null && read.status === 'ok' ? { aside: <span className="hf-small">{formatNumber(Number(read.value.snapshotCount))} in series {String(read.value.series)}</span> } : {})}>
      <div className="lk-snap">
        {snapshots.status !== 'ok' && <Unavailable reason={snapshots.reason} source={snapshots.status === 'unavailable' ? sourceName(snapshots.source) : 'HyperEVM'} at={snapshots.at} now={now} />}
        {read !== null && read.status !== 'ok' && <Unavailable reason={read.reason} source={sourceName(read.source)} at={read.readAt} now={now} />}
        {read !== null && read.status === 'ok' && latest === undefined && (
          <Notice kind="info" title="No snapshot yet">
            <p>The contract holds no snapshot for this account in its current series.</p>
            <p className="hf-small">
              A snapshot is recorded after a tick once the account has named the service&rsquo;s attester key, and no more often than the deployment allows. Naming the key is done on the <Link href={`${base}/safety`}>Safety page</Link>.
            </p>
          </Notice>
        )}
        {read !== null && read.status === 'ok' && latest !== undefined && list !== null && (
          <>
            <p className="hf-small">
              The position, the prices and the HyperCore block are what the contract read for the account in the same transaction; the attester cannot supply them. The root, the count and the commitment are the attester&rsquo;s statements.
            </p>
            <KeyValue
              items={[
                {
                  label: 'Latest',
                  value: (
                    <>
                      snapshot <span className="hf-num">{String(latest.number)}</span> of series <span className="hf-num">{String(latest.series)}</span>, recorded <Timestamp at={latest.at} now={now} />
                    </>
                  ),
                },
                {
                  label: 'Position',
                  value: (
                    <>
                      {latest.shortZec > 0 ? 'short ' : latest.shortZec < 0 ? 'long ' : ''}
                      <span className="hf-num">{formatNumber(Math.abs(latest.shortZec), 2)} ZEC</span> (<span className="hf-num">szi {String(latest.szi)}</span>)
                    </>
                  ),
                },
                { label: 'Oracle price', value: <span className="hf-num">{formatPx(latest.oraclePx)}</span> },
                { label: 'Mark price', value: <span className="hf-num">{formatPx(latest.markPx)}</span> },
                { label: 'HyperCore block', value: <span className="hf-num">{formatNumber(Number(latest.l1Block))}</span> },
                { label: 'Journal entries', value: <span className="hf-num">{formatNumber(Number(latest.journalCount))}</span> },
                { label: 'Journal root', value: <Hash value={latest.journalRoot} what="journal root" /> },
                {
                  label: 'Treasury',
                  value: (
                    <>
                      <Hash value={latest.treasuryCommitment} what="treasury commitment" />
                      <span className="hf-small lk-snap__note"> A salted hash of the balance. The balance is not on chain.</span>
                    </>
                  ),
                },
                { label: 'Transaction', value: <ChainTx chainId={list.chainId} tx={latest.tx} /> },
                {
                  label: 'Contract',
                  value:
                    list.contract === null ? (
                      'none'
                    ) : (
                      <>
                        <Hash value={list.contract} what="address of the contract" />{' '}
                        {contractUrl !== null && (
                          <Link href={contractUrl} external>
                            HedgeAttestor
                          </Link>
                        )}
                      </>
                    ),
                },
              ]}
            />
            <p className="hf-small lk-asof">
              as of <Timestamp at={read.readAt} now={now} />, from {sourceName(read.source)}
            </p>

            {items.length > 1 && (
              <DataTable
                dense
                caption="Earlier snapshots of this series"
                columns={[
                  { key: 'number', header: 'No.', numeric: true },
                  { key: 'at', header: 'Recorded' },
                  { key: 'entries', header: 'Entries', numeric: true },
                  { key: 'tx', header: 'Transaction' },
                ]}
                rows={items.slice(1).map((item) => ({
                  id: snapshotText(item),
                  cells: {
                    number: String(item.number),
                    at: <Timestamp at={item.at} now={now} show="absolute" />,
                    entries: formatNumber(Number(item.journalCount)),
                    tx: <ChainTx chainId={list.chainId} tx={item.tx} />,
                  },
                }))}
              />
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

export interface ProofViewProps {
  base: string;
  now: number;
  snapshots: Snapshots;
  proof: ProofShown | null;
  params: LockParams;
  /** The organisation's id when it is a public demo, whose proofs the public API also serves; null otherwise. */
  publicOrgId: string | null;
}

/**
 * A check any reader can run: is this journal entry under the root a
 * snapshot stored on chain? The page builds the proof from the journal, asks
 * the contract, and prints the call with which the reader can ask it again.
 */
export function ProofView({ base, now, snapshots, proof, params, publicOrgId }: ProofViewProps) {
  const read = snapshots.status === 'ok' ? snapshots.value.snapshots : null;
  const items = read !== null && read.status === 'ok' ? read.value.items : [];
  const chosen = proof?.snapshot ?? (items[0] === undefined ? null : { series: items[0].series, number: items[0].number });
  const options = items.map((item) => ({ value: snapshotText(item), label: `Snapshot ${item.number} of series ${item.series}, ${formatNumber(Number(item.journalCount))} entries` }));
  // A snapshot named in the address that is not among the latest is still offered, so that the form shows what was asked.
  if (chosen !== null && !options.some((option) => option.value === snapshotText(chosen))) options.unshift({ value: snapshotText(chosen), label: `Snapshot ${chosen.number} of series ${chosen.series}` });
  const outcome = proof?.outcome ?? null;

  return (
    <div id="proof">
      <Panel title="Check an entry against the chain" level={2}>
        <div className="lk-proof">
          <p className="hf-small">
            Give the number of an entry a snapshot covers: from 1 to that snapshot&rsquo;s count of entries. The page computes the entry&rsquo;s leaf from its content, builds the Merkle proof from the journal, and asks the contract whether that leaf is under the root it stored.
          </p>

          {options.length === 0 ? (
            <p className="hf-small lk-who">There is no snapshot to check against yet, so there is nothing to ask the contract.</p>
          ) : (
            <form className="lk-proof__form" method="get" action={`${base}/lock#proof`}>
              {params.before !== null && <input type="hidden" name="before" value={params.before} />}
              <Input label="Journal entry" name="check" type="number" inputMode="numeric" min={1} step={1} required numeric defaultValue={proof?.seq ?? ''} />
              <Select label="Snapshot" name="snapshot" options={options} defaultValue={chosen === null ? undefined : snapshotText(chosen)} />
              <Button type="submit" variant="secondary">
                Check the entry
              </Button>
            </form>
          )}

          {proof !== null && outcome !== null && outcome.status === 'unavailable' && <Unavailable reason={outcome.reason} source={sourceName(outcome.source)} at={outcome.at} now={now} />}
          {proof !== null && outcome !== null && outcome.status === 'refused' && (
            <Notice kind="refusal" word="No proof" title={`Entry ${proof.seq}`}>
              <p>{outcome.reason}.</p>
            </Notice>
          )}
          {proof !== null && outcome !== null && outcome.status === 'ok' && (
            <>
              {outcome.value.verified.status !== 'ok' ? (
                <Unavailable reason={outcome.value.verified.reason} source={sourceName(outcome.value.verified.source)} at={outcome.value.verified.readAt} now={now} />
              ) : outcome.value.verified.value ? (
                <Notice kind="info" word="True" title={`Entry ${outcome.value.seq} is under the root of snapshot ${outcome.value.number}`}>
                  <p>
                    The contract answered <span className="hf-num">true</span> to <span className="hf-num">verifyEntry</span> for this leaf and proof, asked <Timestamp at={outcome.value.verified.readAt} now={now} />.
                  </p>
                </Notice>
              ) : (
                <Notice kind="refusal" word="False" title={`Entry ${outcome.value.seq} is not under the root of snapshot ${outcome.value.number}`}>
                  <p>
                    The contract answered <span className="hf-num">false</span> to <span className="hf-num">verifyEntry</span> for this leaf and proof, asked <Timestamp at={outcome.value.verified.readAt} now={now} />.
                  </p>
                </Notice>
              )}
              <KeyValue
                items={[
                  { label: 'Leaf', value: <Hash value={outcome.value.leaf} what="leaf" /> },
                  { label: 'Root', value: <Hash value={outcome.value.journalRoot} what="journal root" /> },
                  { label: 'Entries', value: <span className="hf-num">{formatNumber(Number(outcome.value.journalCount))}</span> },
                  { label: 'Proof', value: `${outcome.value.proof.length} ${outcome.value.proof.length === 1 ? 'node' : 'nodes'}, leaf to root` },
                ]}
              />
              <div className="lk-code">
                <div className="lk-code__head">
                  <p className="hf-px">Ask the contract yourself</p>
                  <CopyButton value={castCall(outcome.value)} what="command" />
                </div>
                <pre className="lk-code__body" tabIndex={0}>
                  <code>{castCall(outcome.value)}</code>
                </pre>
              </div>
              <p className="hf-small">
                The leaf is the entry&rsquo;s digest. <span className="hf-num">verifyEntry</span> accepts any node of the journal tree, so the answer is about this entry only when the leaf was computed from the entry by whoever checks; <span className="hf-num">journalLeaf</span> in{' '}
                <span className="hf-num">packages/attest</span> does that. A snapshot is one moment, and the attester chose it.
              </p>
              {publicOrgId !== null && (
                <p className="hf-small">
                  <Link href={`/api/demo/${encodeURIComponent(publicOrgId)}/attestations/${outcome.value.series}/${outcome.value.number}/proof?seq=${outcome.value.seq}`} external>
                    The same proof as JSON
                  </Link>
                </p>
              )}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
