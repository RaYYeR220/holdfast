import type { ReactNode } from 'react';
import type { TreasurySwap } from '@/server/pages/treasury';
import { CopyButton, DataTable, ExternalTxLink, KeyPlate, KeyValue, Link, Notice, Panel, Plate, SectionHeading, StateTag, Tag, Tick, Timestamp, Unavailable, formatNumber, formatUsd, shorten } from '@/ui';
import { ReadingGap, ReadingStat, sourceName } from '../overview/OverviewBody';
import { accountsFor, deliveredText, purposeWords, swapWords, withFees, zecText } from './figures';
import type { TreasuryData } from './load';
import './treasury.css';

/**
 * The Treasury page: what the viewing key shows of the treasury, what stays
 * private and what does not, and the swaps that turned ZEC into dollars on
 * the team's own accounts. The public demo and the owner's page both render
 * it; the owner's page hands in the funding panel.
 */

export interface TreasuryViewProps {
  /** The area the page is in: "/demo" or "/app". */
  base: string;
  /** The server's clock at render. */
  now: number;
  data: TreasuryData;
  /** The owner's funding panel; without it the page says who can fund and how. */
  funding?: ReactNode;
}

/** Where the mainnet record describes the swap that funded the demo treasury's margin. */
const PROOF_MARGIN_URL = 'https://github.com/RaYYeR220/holdfast/blob/main/docs/PROOF.md#2-margin-zec-becomes-dollars-on-the-teams-own-hyperliquid-account';

const POOL: Record<string, string> = { sapling: 'Sapling', orchard: 'Orchard', ironwood: 'Ironwood', transparent: 'Transparent' };
const poolName = (pool: string): string => POOL[pool] ?? pool;

function ZcashTx({ id, linked }: { id: string; linked: boolean }) {
  if (!linked) {
    return (
      <CopyButton value={id} what="transaction id">
        {shorten(id, 8, 6)}
      </CopyButton>
    );
  }
  return <ExternalTxLink chain="zcash" id={id} showChain={false} />;
}

function Balance({ data, now, owner }: { data: TreasuryData; now: number; owner: boolean }) {
  const { treasury } = data;
  const { scan, balance, valueUsd, address } = treasury;
  return (
    <Panel
      framed
      title="Shielded balance"
      level={2}
      aside={
        scan === null ? (
          <StateTag state="stale" label="Not scanned yet" boxed />
        ) : scan.caughtUp ? (
          <StateTag state="locked" label={`Scanned to block ${formatNumber(scan.to)}`} boxed />
        ) : (
          <StateTag state="limit" label={`Catching up: ${formatNumber(scan.to)} of ${formatNumber(scan.tip)}`} boxed />
        )
      }
    >
      <div className="tr-now">
        <div className="tr-now__main">
          <ReadingStat label="Read with the viewing key" size="large" reading={balance} failure={null} now={now} show={(v) => ({ figure: v.zec, unit: 'ZEC', note: `The unspent notes of the treasury, as tick ${formatNumber(v.seq)} of the controller read them.` })} />
          <p className="hf-small tr-scan">
            {scan === null ? (
              <>
                No tick has scanned for this treasury yet. The first scan starts at block <span className="hf-num">{formatNumber(treasury.birthday)}</span>, the birthday it was registered with, and reads at most 5,000 blocks a tick.
              </>
            ) : (
              <>
                The scan runs from block <span className="hf-num">{formatNumber(treasury.birthday)}</span>, the treasury&rsquo;s birthday, and re-reads the last 20 blocks on every tick. Tick <span className="hf-num">{formatNumber(scan.seq)}</span> read to block{' '}
                <span className="hf-num">{formatNumber(scan.to)}</span> with the chain at <span className="hf-num">{formatNumber(scan.tip)}</span>, <Timestamp at={scan.at} now={now} />.
              </>
            )}
          </p>
          <div className="tr-address">
            <p className="hf-px">{owner ? 'An address of the treasury' : 'An address of the demo treasury'}</p>
            {address.status !== 'ok' ? (
              <ReadingGap reading={address} failure={null} now={now} />
            ) : (
              <>
                <p className="tr-address__value">
                  <CopyButton value={address.value} what="treasury address">
                    {address.value}
                  </CopyButton>
                </p>
                <p className="hf-small">A unified address the viewing key receives on, derived from the key: its Orchard receiver. A wallet may show the same account under other addresses. The key itself is never shown.</p>
              </>
            )}
          </div>
        </div>
        <div className="tr-now__side">
          <ReadingStat
            label="Dollar value at the reference price"
            reading={valueUsd}
            failure={null}
            now={now}
            show={(v) => ({
              figure: formatUsd(v.usd),
              note: (
                <>
                  At {formatUsd(v.px)} a ZEC: the median of independent price sources, quoted <Timestamp at={v.priceAsOf} now={now} show="relative" />. It is a valuation, not a price anyone has agreed to pay.
                </>
              ),
            })}
          />
          <MadeUp data={data} />
        </div>
      </div>
    </Panel>
  );
}

function Received({ data, now }: { data: TreasuryData; now: number }) {
  const { activity, network } = data.treasury;
  const linked = network === 'mainnet';
  return (
    <Panel title="Payments in" level={2} flush {...(activity.status === 'ok' ? { aside: <span className="hf-small">{formatNumber(activity.value.received.length)} shown</span> } : {})}>
      <div className="tr-pad">
        {activity.status !== 'ok' ? (
          <ReadingGap reading={activity} failure={null} now={now} />
        ) : (
          <>
            <DataTable
              className="tr-table"
              caption="Payments made to the treasury, newest first"
              captionHidden
              columns={[
                { key: 'at', header: 'Received' },
                { key: 'height', header: 'Block', numeric: true },
                { key: 'amount', header: 'ZEC', numeric: true },
                { key: 'memo', header: 'Memo', rowHeader: true },
                { key: 'note', header: 'Note' },
                { key: 'tx', header: 'Transaction' },
              ]}
              rows={activity.value.received.map((payment) => ({
                id: payment.id,
                cells: {
                  at: <Timestamp at={payment.time} now={now} show="absolute" />,
                  height: formatNumber(payment.height),
                  amount: payment.zec,
                  memo: payment.memo === '' ? <span className="tr-quiet">No memo</span> : <span className="tr-memo">{payment.memo}</span>,
                  note: (
                    <span className="tr-note">
                      <Tag variant="plain">{poolName(payment.pool)}</Tag>
                      <span className="hf-small">{payment.spent ? 'since spent' : 'unspent'}</span>
                    </span>
                  ),
                  tx: <ZcashTx id={payment.txid} linked={linked} />,
                },
              }))}
              empty="No payment has reached the treasury in the blocks scanned so far. A payment to the address above shows here after the tick that scans its block."
            />
            <p className="hf-small tr-foot">
              An explorer shows that each transaction exists and neither its amount nor its memo. Both are read here with the viewing key. <span className="tr-asof">As of <Timestamp at={activity.readAt} now={now} />, from {sourceName(activity.source)}.</span>
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

function Sent({ data, now }: { data: TreasuryData; now: number }) {
  const { activity, network } = data.treasury;
  const linked = network === 'mainnet';
  return (
    <Panel title="Sent by the treasury" level={2} flush>
      <div className="tr-pad">
        {activity.status !== 'ok' ? (
          <ReadingGap reading={activity} failure={null} now={now} />
        ) : (
          (() => {
            const { rows, otherFees } = withFees(activity.value.sent, activity.value.fees);
            return (
              <>
                <DataTable
                  className="tr-table"
                  caption="What the treasury sent, newest first, with the fee of each transaction"
                  captionHidden
                  columns={[
                    { key: 'at', header: 'Sent' },
                    { key: 'height', header: 'Block', numeric: true },
                    { key: 'amount', header: 'ZEC', numeric: true },
                    { key: 'fee', header: 'Fee', numeric: true },
                    { key: 'pool', header: 'Left through', rowHeader: true },
                    { key: 'tx', header: 'Transaction' },
                  ]}
                  rows={rows.map((payment) => ({
                    id: payment.id,
                    cells: {
                      at: <Timestamp at={payment.time} now={now} show="absolute" />,
                      height: formatNumber(payment.height),
                      amount: payment.zec,
                      fee: payment.fee === null ? <span className="tr-quiet">with another row</span> : payment.fee.zec,
                      pool: (
                        <span className="tr-memo">
                          {payment.pool === 'transparent' ? 'A transparent output: public on the chain.' : `The ${poolName(payment.pool)} pool: shielded.`}
                          {payment.memo === '' ? '' : ` Memo: ${payment.memo}`}
                        </span>
                      ),
                      tx: <ZcashTx id={payment.txid} linked={linked} />,
                    },
                  }))}
                  empty="The treasury has sent nothing in the blocks scanned so far."
                />
                {otherFees.length > 0 && (
                  <p className="hf-small tr-foot">
                    Fees of transactions with no payment in the list above: {otherFees.map((fee) => `${fee.zec} ZEC at block ${formatNumber(fee.height)}`).join('; ')}.
                  </p>
                )}
                <p className="hf-small tr-foot">A viewing key shows how much left the treasury and through which pool. Every spend was signed in the treasurer&rsquo;s own wallet; the service holds no key that can spend.</p>
              </>
            );
          })()
        )}
      </div>
    </Panel>
  );
}

/** What the rows of the page add up to, set beside the balance they should account for. */
function MadeUp({ data }: { data: TreasuryData }) {
  const { activity, balance } = data.treasury;
  if (activity.status !== 'ok' || balance.status !== 'ok') return null;
  const { totals, change, truncated } = activity.value;
  return (
    <div className="tr-made">
      <p className="hf-px">How the balance is made up</p>
      <KeyValue
        items={[
          { label: 'Received', value: <span className="hf-num">{zecText(totals.receivedZat)} ZEC</span> },
          { label: 'Sent', value: <span className="hf-num">{zecText(totals.sentZat)} ZEC</span> },
          { label: 'Fees', value: <span className="hf-num">{zecText(totals.feesZat)} ZEC</span> },
        ]}
      />
      {accountsFor(totals, balance.value.zat) ? (
        <p className="hf-small">
          <Tick /> Received, less sent and fees, is the balance.
        </p>
      ) : (
        <p className="hf-small">Received, less sent and fees, is not the balance shown. That is so when the treasury holds notes whose spends a viewing key cannot follow.</p>
      )}
      {change.count > 0 && (
        <p className="hf-small">
          <span className="hf-num">{change.zec} ZEC</span> of the balance came back as change from the treasury&rsquo;s own spends, in {formatNumber(change.count)} {change.count === 1 ? 'note' : 'notes'}. Change is not a payment in.
        </p>
      )}
      {truncated && <p className="hf-small">The lists below show the latest hundred rows each; these totals cover every row.</p>}
    </div>
  );
}

function ViewingKey() {
  return (
    <Panel title="The viewing key" level={2}>
      <div className="tr-key">
        <Plate>
          <KeyPlate kind="view" label="The viewing key, drawn as a key with an eye for a bow" className="tr-key__plate" />
        </Plate>
        <dl className="tr-can">
          <div>
            <dt className="hf-px">
              <i className="hf-swatch hf-pat-locked" aria-hidden="true" />
              It can
            </dt>
            <dd>Read payments in, their memos, the balance, and what the treasury itself sent.</dd>
          </div>
          <div>
            <dt className="hf-px">
              <i className="hf-swatch hf-pat-refused" aria-hidden="true" />
              It cannot
            </dt>
            <dd>Spend, or sign anything. The Zcash protocol gives a viewing key no authority to spend.</dd>
          </div>
        </dl>
        <p className="hf-small">It is the only Zcash key the service takes. A spending key or a seed phrase pasted in its place is refused by its shape.</p>
      </div>
    </Panel>
  );
}

function Privacy({ demo }: { demo: boolean }) {
  return (
    <Panel title="Private and public" level={2}>
      <div className="tr-privacy">
        <section>
          <h3 className="hf-px tr-sub">
            <i className="hf-swatch hf-pat-locked" aria-hidden="true" />
            Stays private
          </h3>
          <ul className="tr-lines">
            <li>The payments made to the treasury&rsquo;s shielded address, their amounts and their memos.</li>
            <li>The balance. A snapshot on HyperEVM commits to it with a salted hash and does not show it.</li>
          </ul>
          <p className="hf-small">
            Only the holder of the viewing key reads them. The service holds that key, so whoever operates the server sees the treasury; hosting the service yourself is the answer to that.
            {demo ? ' The demo treasury’s viewing key is published on purpose, which is why this page can show its payments to anyone: the demo treasury is not private.' : ''}
          </p>
        </section>
        <section>
          <h3 className="hf-px tr-sub">
            <i className="hf-swatch hf-pat-unlocked" aria-hidden="true" />
            Is public
          </h3>
          <ul className="tr-lines">
            <li>The hedge: the Hyperliquid account, its position, fills and funding. At a hedge ratio of 100% the size of the short is the size of the ZEC the treasury holds.</li>
            <li>Every payment into a swap. The swap service takes transparent ZEC only, so the amount and the deposit address are on the chain.</li>
            <li>The payouts on Tempo and Solana, with their amounts, recipients and memos.</li>
            <li>Each snapshot on HyperEVM: the position, the prices, the journal root and the number of entries.</li>
          </ul>
        </section>
      </div>
    </Panel>
  );
}

function SwapSlip({ swap, now, linked }: { swap: TreasurySwap; now: number; linked: boolean }) {
  const purpose = purposeWords(swap.purpose);
  const words = swapWords(swap.state);
  return (
    <li className="tr-swap">
      <div className="tr-swap__head">
        <p className="hf-px tr-swap__title">
          {zecText(swap.amountIn)} ZEC into {purpose.delivers}
        </p>
        <StateTag state={words.state} label={words.label} boxed />
      </div>
      <p className="hf-small">
        {words.text} <span className="tr-asof">Asked for <Timestamp at={swap.createdAt} now={now} />; last heard of <Timestamp at={swap.updatedAt} now={now} show="relative" />.</span>
      </p>
      <KeyValue
        items={[
          {
            label: 'Delivered',
            value:
              swap.amountOut !== null ? (
                <span className="hf-num">{deliveredText(swap.amountOut, purpose)}</span>
              ) : (
                <>
                  nothing yet; at least <span className="hf-num">{deliveredText(swap.minAmountOut, purpose)}</span> was quoted
                </>
              ),
          },
          {
            label: 'To',
            value: (
              <CopyButton value={swap.recipient} what="address of the receiving account">
                {shorten(swap.recipient, 10, 8)}
              </CopyButton>
            ),
          },
          {
            label: 'Deposit address',
            value: (
              <CopyButton value={swap.depositAddress} what="deposit address">
                {shorten(swap.depositAddress, 10, 8)}
              </CopyButton>
            ),
          },
          {
            label: 'Deposit',
            value:
              swap.originTxs.length === 0 ? (
                'The swap service has named no deposit transaction.'
              ) : (
                <span className="tr-txs">
                  {swap.originTxs.map((tx) => (
                    <ZcashTx key={tx} id={tx} linked={linked} />
                  ))}
                </span>
              ),
          },
          {
            label: 'Receiving',
            value:
              swap.destinationTxs.length === 0 ? (
                'No receiving transaction yet.'
              ) : (
                <span className="tr-txs">
                  {swap.destinationTxs.map((tx) =>
                    purpose.chain === null ? (
                      <CopyButton key={tx} value={tx} what="transaction id">
                        {shorten(tx, 8, 6)}
                      </CopyButton>
                    ) : (
                      <ExternalTxLink key={tx} chain={purpose.chain} id={tx} />
                    ),
                  )}
                </span>
              ),
          },
        ]}
      />
    </li>
  );
}

function Swaps({ data, now, owner }: { data: TreasuryData; now: number; owner: boolean }) {
  const { swaps, network } = data.treasury;
  return (
    <Panel title="Swaps" level={2} {...(swaps.status === 'ok' ? { aside: <span className="hf-small">{formatNumber(swaps.value.length)} on record</span> } : {})}>
      <div className="tr-swaps">
        <p className="hf-small tr-swaps__lead">
          ZEC becomes dollars through a NEAR Intents swap that delivers to an account of the team&rsquo;s own. The treasurer pays the deposit from their own wallet; the service holds nothing at any point.
        </p>
        {swaps.status !== 'ok' ? (
          <Unavailable reason={swaps.reason} source={sourceName(swaps.source)} at={swaps.readAt} now={now} />
        ) : swaps.value.length === 0 ? (
          <Notice kind="info" title="No swap on record here">
            {owner ? (
              <p>No swap has been asked for. A quote above starts one; nothing moves until you pay its payment request.</p>
            ) : (
              <>
                <p>The service&rsquo;s database holds no swap of this treasury.</p>
                {data.org.publicDemo && (
                  <p className="hf-small">
                    The swap that turned 0.0093 ZEC of the demo treasury into margin is in the mainnet record, with the Zcash payment into it and the transaction that delivered the dollars:{' '}
                    <Link href={PROOF_MARGIN_URL} external>
                      PROOF, section 2
                    </Link>
                    .
                  </p>
                )}
              </>
            )}
          </Notice>
        ) : (
          <ul className="tr-swaps__list">
            {swaps.value.map((swap) => (
              <SwapSlip key={swap.id} swap={swap} now={now} linked={network === 'mainnet'} />
            ))}
          </ul>
        )}
        {!owner && (
          <p className="hf-small tr-who">
            Only the owner of the treasury can ask for a quote, and only their own Zcash wallet can pay it: the service writes a ZIP-321 payment request and builds no Zcash transaction.
          </p>
        )}
      </div>
    </Panel>
  );
}

export function TreasuryView({ base, now, data, funding }: TreasuryViewProps) {
  const owner = funding !== undefined;
  return (
    <div className="hf-stack tr">
      <SectionHeading
        level={1}
        size="page"
        title="Treasury"
        lead={
          owner
            ? 'What the viewing key shows of your treasury: its balance, the payments that reached it and what it sent. Moving ZEC is always a payment you sign in your own wallet.'
            : 'What the viewing key shows of the demo treasury: its balance, the payments that reached it and what it sent. The key reads; it cannot spend.'
        }
      />

      <Balance data={data} now={now} owner={owner} />
      <Received data={data} now={now} />

      <Sent data={data} now={now} />

      <div className="hf-grid tr-about">
        <ViewingKey />
        <Privacy demo={data.org.publicDemo} />
      </div>

      {funding !== undefined && <div id="funding">{funding}</div>}

      <div id="swaps">
        <Swaps data={data} now={now} owner={owner} />
      </div>

      {owner ? null : (
        <p className="hf-small tr-who">
          The hedge these swaps fund is on the <Link href={`${base}/lock`}>Lock page</Link>.
        </p>
      )}
    </div>
  );
}
