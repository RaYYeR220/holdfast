import type { AttestationList } from '@/server/attestations/service';
import type { DemoJournal } from '@/server/demo/service';
import type { Outcome } from '@/server/pages/treasury-lock-reads';
import { CopyButton, DataTable, Link, Panel, StateTag, Tag, Timestamp, Unavailable, shorten } from '@/ui';
import { sourceName } from '../overview/OverviewBody';
import { type LockParams, lockHref } from './params';
import { decisionWords, orderWords } from './words';

export interface JournalViewProps {
  base: string;
  now: number;
  journal: Outcome<DemoJournal>;
  snapshots: Outcome<AttestationList>;
  params: LockParams;
}

/** The newest snapshot of the current series, when the chain could be read and holds one. */
function latestSnapshot(snapshots: Outcome<AttestationList>) {
  if (snapshots.status !== 'ok' || snapshots.value.snapshots.status !== 'ok') return null;
  return snapshots.value.snapshots.value.items[0] ?? null;
}

/**
 * The controller's journal, newest first: what each tick decided and why,
 * the order it placed if it placed one, and the digest that chains the entry
 * to the one before. An entry the latest snapshot covers links to its proof.
 */
export function JournalView({ base, now, journal, snapshots, params }: JournalViewProps) {
  const latest = latestSnapshot(snapshots);
  const covered = latest === null ? 0 : Number(latest.journalCount);

  return (
    <div id="journal">
      <Panel
        title="Controller journal"
        level={2}
        flush
        {...(journal.status === 'ok' && journal.value.chain !== null
          ? { aside: journal.value.chain.ok ? <StateTag state="locked" label="Chain intact" boxed /> : <StateTag state="refused" label="Chain broken" boxed /> }
          : {})}
      >
        <div className="lk-pad">
          <p className="hf-small lk-journal__lead">
            One entry a tick, once a minute. Each entry&rsquo;s digest covers its inputs, its decision and the entry before it, so an entry cannot be changed without breaking every digest after it.
          </p>
          {journal.status === 'unavailable' && <Unavailable reason={journal.reason} source={sourceName(journal.source)} at={journal.at} now={now} />}
          {journal.status === 'refused' && <Unavailable reason={journal.reason} source="the journal" at={journal.at} now={now} />}
          {journal.status === 'ok' && (
            <>
              <DataTable
                dense
                className="lk-journal"
                caption={params.before === null ? 'The controller journal, newest entries first' : `The controller journal before entry ${params.before}, newest first`}
                captionHidden
                columns={[
                  { key: 'seq', header: 'Entry', numeric: true },
                  { key: 'what', header: 'What it decided', rowHeader: true },
                  { key: 'at', header: 'Ran' },
                  { key: 'digest', header: 'Digest' },
                  { key: 'proof', header: 'On chain' },
                ]}
                rows={journal.value.entries.map((entry) => {
                  const words = decisionWords(entry);
                  const order = orderWords(entry.order);
                  return {
                    id: String(entry.seq),
                    cells: {
                      seq: entry.seq,
                      what: (
                        <span className="lk-journal__what">
                          <span className="lk-journal__tags">
                            <Tag variant={entry.decision.mode === 'HOLD' ? 'plain' : 'solid'}>{words.mode}</Tag>
                            {words.state !== null && words.stateLabel !== null && <StateTag state={words.state} label={words.stateLabel} />}
                          </span>
                          <span>{words.lines.join(' ')}</span>
                          {order !== null && <span className="lk-journal__order">{order}</span>}
                        </span>
                      ),
                      at: <Timestamp at={entry.at} now={now} />,
                      digest: (
                        <CopyButton value={entry.digest} what={`digest of entry ${entry.seq}`}>
                          {shorten(entry.digest, 8, 6)}
                        </CopyButton>
                      ),
                      proof:
                        entry.seq <= covered ? (
                          <Link href={lockHref(base, { before: params.before, check: entry.seq }, 'proof')} aria-label={`Check entry ${entry.seq} against the latest snapshot`}>
                            Check
                          </Link>
                        ) : latest === null ? (
                          <span className="hf-small">No snapshot</span>
                        ) : (
                          <span className="hf-small">Not yet</span>
                        ),
                    },
                  };
                })}
                empty="No tick has run for this organisation yet. The first entry is written by the first tick."
              />

              {journal.value.chain !== null && (
                <p className="hf-small lk-journal__chain">
                  {journal.value.chain.ok ? (
                    <>
                      Entries {journal.value.chain.fromSeq} to {journal.value.chain.toSeq} link digest to digest and each matches its content, checked on the stored entries as this page was made.
                      {journal.value.isHead === true && ' The newest is the entry the organisation’s record names as its last.'}
                      {journal.value.isHead === false && ' The newest entry is not the one the organisation’s record names as its last.'}
                    </>
                  ) : (
                    <>
                      The chain breaks at entry {journal.value.chain.seq}: {journal.value.chain.reason}.
                    </>
                  )}
                </p>
              )}

              <nav className="lk-journal__pages" aria-label="Pages of the journal">
                {params.before !== null && (
                  <Link href={lockHref(base, {}, 'journal')} variant="emphasis">
                    Newest entries
                  </Link>
                )}
                {journal.value.nextBeforeSeq !== null && (
                  <Link href={lockHref(base, { before: journal.value.nextBeforeSeq }, 'journal')} variant="emphasis">
                    Older entries, before {journal.value.nextBeforeSeq}
                  </Link>
                )}
                {latest !== null && params.before === null && covered > 0 && (journal.value.entries.at(-1)?.seq ?? 0) > covered && (
                  <Link href={lockHref(base, { before: covered + 1 }, 'journal')} variant="emphasis">
                    Entries the latest snapshot covers, {covered} and before
                  </Link>
                )}
              </nav>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
