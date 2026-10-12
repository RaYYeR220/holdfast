import type { LockPage } from '@/server/pages/lock';
import { KeyValue, Link, Notice, Panel, Timestamp, Unavailable, formatBps, formatUsd } from '@/ui';
import { sourceName } from '../overview/OverviewBody';
import { previewFigures, zecText } from './preview';
import { formatPx, lotsAsZec, lotsWords } from './words';

export interface PreviewViewProps {
  preview: LockPage['preview'];
  lockEnabled: boolean;
  now: number;
  /** Whether the reader is the owner, who can act on the plan. */
  owner: boolean;
  base: string;
}

/**
 * What locking the treasury as it is now would take: how much ZEC is sold
 * for margin, how much stays and is hedged, and how far the price can rise
 * before the first buy-back. A plan that cannot be made says why.
 */
export function PreviewView({ preview, lockEnabled, now, owner, base }: PreviewViewProps) {
  return (
    <Panel title="Lock preview" level={2}>
      <div className="lk-preview">
        <p className="hf-small">A plan for the treasury as it stands, starting from no margin and no short. It sends nothing.</p>
        {preview.status === 'unavailable' && <Unavailable reason={preview.reason} source={sourceName(preview.source)} at={preview.at} now={now} />}
        {preview.status === 'refused' && (
          <Notice kind="refusal" word="No plan" title="The planner refused" announce={false}>
            <p>The server&rsquo;s reason: {preview.reason}.</p>
            <p className="hf-small">
              The plan sells part of the balance for margin first and hedges what is left.
              {lockEnabled ? ' A treasury that is already locked has made that sale; the figures of its lock are above.' : ''}
            </p>
          </Notice>
        )}
        {preview.status === 'ok' &&
          (() => {
            const { inputs, assumed, plan } = preview.value;
            const { keptZat, soldShareBps, swapCostUsd } = previewFigures({ treasuryZat: inputs.treasury.zat, sellZat: plan.sellZat, px: inputs.price.px, swapCostBps: assumed.swapCostBps });
            return (
              <>
                <KeyValue
                  stacked
                  items={[
                    {
                      label: 'Treasury',
                      value: (
                        <>
                          <span className="hf-num">{inputs.treasury.zec} ZEC</span>, read <Timestamp at={inputs.treasury.readAt} now={now} show="relative" />
                        </>
                      ),
                    },
                    {
                      label: 'Sold for margin',
                      value: (
                        <>
                          <span className="hf-num">{plan.sellZec} ZEC</span>, {formatBps(soldShareBps)} of the treasury
                        </>
                      ),
                    },
                    {
                      label: 'Kept and hedged',
                      value: (
                        <>
                          <span className="hf-num">{zecText(keptZat)} ZEC</span> against a short of {lotsWords(plan.hedgeLots)}, {lotsAsZec(plan.hedgeLots)}
                        </>
                      ),
                    },
                    {
                      label: 'Margin that arrives',
                      value: (
                        <>
                          <span className="hf-num">{formatUsd(plan.marginUsd)}</span>, a starting ratio of {formatBps(plan.marginRatioBps)}
                        </>
                      ),
                    },
                    {
                      label: 'Cost of the swap',
                      value: (
                        <>
                          <span className="hf-num">{formatUsd(swapCostUsd)}</span> at {formatBps(assumed.swapCostBps, 2)} of what is sold. This rate is the planner&rsquo;s allowance; a quote states the real one.
                        </>
                      ),
                    },
                    {
                      label: 'First buy-back',
                      value: (
                        <>
                          after a rise of <span className="hf-num">{formatBps(plan.firstDeRiskUpMoveBps)}</span> with no top-up
                        </>
                      ),
                    },
                    {
                      label: 'Liquidation',
                      value: (
                        <>
                          of an untouched short after a rise of <span className="hf-num">{formatBps(plan.liquidationUpMoveBps)}</span>, taking the venue&rsquo;s maintenance margin as {formatBps(assumed.maintenanceBps)}
                        </>
                      ),
                    },
                    {
                      label: 'Price used',
                      value: (
                        <>
                          a mark of <span className="hf-num">{formatPx(inputs.price.px)}</span>, read <Timestamp at={inputs.price.readAt} now={now} show="relative" />
                        </>
                      ),
                    },
                  ]}
                />
                <p className="hf-small">The exchange&rsquo;s fee, slippage on the order and funding are not in this plan.</p>
                {owner ? (
                  <p className="hf-small">
                    The sale is a payment you make from your own wallet: <Link href={`${base}/treasury#funding`}>ask for a quote on the Treasury page</Link>.
                  </p>
                ) : (
                  <p className="hf-small lk-who">The sale for margin is a payment the treasurer makes from their own wallet; the service cannot make it.</p>
                )}
              </>
            );
          })()}
      </div>
    </Panel>
  );
}
