import NextLink from 'next/link';
import { Suspense } from 'react';
import { BooksPlate, Button, ChainPlate, ExternalTxLink, KeyPlate, Tick, Unavailable, WorstBars, formatPct, formatUsd } from '@/ui';
import { type Backtest, type ScenarioRow, loadBacktest } from './_lib/backtest';
import { Hero } from './_landing/Hero';
import { LiveNow, LiveNowLoading } from './_landing/LiveNow';
import { RefusalLedger } from './_landing/RefusalLedger';
import { ControlChart, FootBed, JuneReplay, TapeChart } from './_landing/charts';
import { DOCS_URL, KEYS, NOT_CLAIMED, PAYOUTS, PRIVACY, RECORDED, REFUSALS, REPOSITORY_URL } from './_landing/facts';
import './landing.css';

// The live treasury is read at every request; the backtest behind the pictures is computed once for the process.
export const dynamic = 'force-dynamic';

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const word = (n: number) => WORDS[n] ?? String(n);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The four tones as a band, closing a section. */
function Band({ ground }: { ground: 'ink' | 'paper' }) {
  return (
    <div className={`hf-band hf-${ground}`} aria-hidden="true">
      <i className="hf-t12" />
      <i className="hf-t25" />
      <i className="hf-t50" />
      <i className="hf-t75" />
    </div>
  );
}

function ScenarioItem({ scenario }: { scenario: ScenarioRow }) {
  const met = scenario.checks.filter((check) => check.pass).length;
  return (
    <li className={`lp-row hf-rule-dot${scenario.control ? ' lp-row--control' : ''}`}>
      <div className="lp-row__a">
        <h3 className="hf-px">{scenario.title}</h3>
        <p className="lp-row__ctx">{scenario.context}</p>
      </div>
      <div>
        <WorstBars
          scale={50}
          bars={[
            { label: 'Locked', value: scenario.lockedWorstPct, text: formatPct(scenario.lockedWorstPct), state: scenario.control ? 'refused' : 'locked' },
            { label: 'Unlocked', value: scenario.unlockedWorstPct, text: formatPct(scenario.unlockedWorstPct), state: 'unlocked' },
          ]}
        />
        <dl className="lp-meta">
          <div>
            <dt>Top-ups</dt>
            <dd>{scenario.topUps}</dd>
          </div>
          <div>
            <dt>Buy-backs</dt>
            <dd>{scenario.buyBacks}</dd>
          </div>
          <div>
            <dt>Ends</dt>
            <dd>{scenario.endCoveragePct}%</dd>
            <dt>hedged</dt>
            <span className="lp-cov hf-pat-limit" aria-hidden="true">
              <i style={{ width: `${scenario.endCoveragePct}%` }} />
            </span>
          </div>
        </dl>
      </div>
      <p className="lp-res">
        <b>
          {scenario.control ? (
            <>
              <i className="hf-swatch hf-pat-refused" aria-hidden="true" />
              Lock failed, as written
            </>
          ) : (
            <>
              <Tick />
              {met} of {scenario.checks.length} met
            </>
          )}
        </b>
        <em>{scenario.checks.map((check) => capital(check.label)).join('; ')}.</em>
      </p>
    </li>
  );
}

function Scorecard({ data }: { data: Backtest }) {
  const { scenarios, control, answered } = data;
  const graded = scenarios.filter((s) => !s.control);
  const held = graded.filter((s) => s.pass).length;
  const controls = scenarios.filter((s) => s.control);
  const controlRow = controls[0];
  const verdict =
    held === graded.length && controls.length === 1
      ? `${word(held)} hold. The ${ORDINALS[scenarios.length] ?? 'last'} is a control that was written to fail, and does.`
      : `${word(held)} of ${graded.length} graded scenarios hold.`;
  return (
    <section className="lp-sec hf-paper" id="score" aria-labelledby="h-score">
      <div className="lp-in">
        <div className="lp-head">
          <h2 className="hf-px" id="h-score">
            {word(scenarios.length)} scenarios, written down before the first run
          </h2>
          <p className="lp-lead">
            Windows and pass criteria were written down before the first run. The first default (45% margin) failed four of nine; the default became 80% margin and the criteria stayed. {verdict}
          </p>
        </div>
        <p className="lp-legend" aria-hidden="true">
          <span>
            <i className="hf-swatch hf-pat-locked" />
            locked
          </span>
          <span>
            <i className="hf-swatch hf-pat-unlocked" />
            unlocked, the same treasury with no lock
          </span>
          <span>
            <i className="hf-swatch hf-pat-refused" />
            the lock failed
          </span>
          <span>
            <Tick />
            written criteria met
          </span>
        </p>
        <div className="lp-rows">
          <div className="lp-rowhead hf-px" aria-hidden="true">
            <span>Scenario</span>
            <span>Worst point, against the starting value</span>
            <span>Written criteria</span>
          </div>
          <ol>
            {scenarios.map((scenario) => (
              <ScenarioItem key={scenario.id} scenario={scenario} />
            ))}
          </ol>
        </div>
        <div className="lp-fail" id="control">
          <figure>
            <div className="lp-pic lp-framed lp-control">
              <ControlChart control={control} />
            </div>
            <figcaption>The control, April 29 to June 15, drawn every six hours. Top: the price. Middle: how much of the treasury the hedge still covers. Bottom: the dollar value of the locked treasury.</figcaption>
          </figure>
          <div className="lp-fail__text">
            <h3 className="hf-px">The control: where the lock fails</h3>
            <p>A lock needs margin top-ups in a strong rally. In this replay ZEC doubled and every top-up request was ignored.</p>
            {controlRow !== undefined && (
              <p>
                As the margin ran down, the controller bought the hedge back in {controlRow.buyBacks} steps, until {controlRow.endCoveragePct}% of the treasury was covered. The June crash then hit a treasury that was almost
                unhedged.
              </p>
            )}
            <div className="lp-duo">
              <p>
                <strong>{formatPct(control.lockedWorstPct)}</strong>
                <span>
                  <i className="hf-swatch hf-pat-refused" aria-hidden="true" />a lock nobody topped up
                </span>
              </p>
              <p>
                <strong>{formatPct(control.unlockedWorstPct)}</strong>
                <span>
                  <i className="hf-swatch hf-pat-unlocked" aria-hidden="true" />
                  no lock at all
                </span>
              </p>
            </div>
            <p>
              An ignored lock in a doubling is worse than no lock. On the same path, with {answered.topUps} top-ups approved within 24 hours, the worst point was {formatPct(answered.lockedWorstPct)}.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export default async function LandingPage() {
  const backtest = await loadBacktest();
  const data = backtest.status === 'ok' ? backtest.data : null;
  const missing = backtest.status === 'unavailable' ? backtest.reason : '';
  const [featured, ...others] = REFUSALS;
  const networked = others.filter((refusal) => refusal.proof !== null);
  const unsigned = others.filter((refusal) => refusal.proof === null);

  return (
    <div className="lp">
      <Hero />

      <main>
        {/* The problem */}
        <section className="lp-sec hf-paper" id="june" aria-labelledby="h-june">
          <div className="lp-in">
            <div className="lp-head">
              <h2 className="hf-px" id="h-june">
                {data === null ? 'In June 2026 ZEC fell by more than half' : `In June 2026 ZEC fell from ${formatUsd(data.june.startPx, 0)} to ${formatUsd(data.june.lowPx, 0)}`}
              </h2>
              <p className="lp-lead">Holdfast is for teams paid in ZEC: Zcash grantees, ecosystem organizations, grant treasuries, miners. Their income is in ZEC and their costs are in dollars, with no hedge in between.</p>
            </div>
            {data === null ? (
              <Unavailable reason={`The June replay could not be computed: ${missing}`} source="market data" />
            ) : (
              <JuneReplay june={data.june}>
                <p className="lp-note">The lock is a short ZEC perpetual on Hyperliquid, sized to the treasury. When ZEC falls, the short gains what the treasury loses.</p>
                <p className="lp-note lp-small">The short also earns funding, about 11&ndash;12% a year recently. That is not guaranteed: it was negative in June 2026.</p>
              </JuneReplay>
            )}
          </div>
        </section>
        <Band ground="paper" />

        {/* How it works */}
        <section className="lp-sec hf-ink" id="keys" aria-labelledby="h-keys">
          <div className="lp-in">
            <div className="lp-head">
              <h2 className="hf-px" id="h-keys">
                Four keys, each limited to one job
              </h2>
              <p className="lp-lead">Holdfast reads the treasury on Zcash, hedges it on Hyperliquid and pays contractors on Tempo and Solana. Each job runs on a key that can do that job and cannot move the treasury.</p>
            </div>
            <div className="lp-keylist">
              <div className="lp-keyhead hf-px" aria-hidden="true">
                <span>Key</span>
                <span>Can</span>
                <span>Cannot</span>
                <span>Enforced by</span>
              </div>
              <ul>
                {KEYS.map((key) => (
                  <li className="lp-keyrow hf-rule-dot" key={key.kind}>
                    <KeyPlate kind={key.kind} label={`${key.name}, drawn as a key`} className="lp-kp" />
                    <div className="lp-kn">
                      <h3 className="hf-px">{key.name}</h3>
                      <p>
                        {key.chain}, {key.job}
                      </p>
                    </div>
                    <dl className="lp-kd">
                      <div>
                        <dt className="hf-px">Can</dt>
                        <dd>{key.can}</dd>
                      </div>
                      <div>
                        <dt className="hf-px">Cannot</dt>
                        <dd>{key.cannot}</dd>
                      </div>
                      <div>
                        <dt className="hf-px">Enforced by</dt>
                        <dd>{key.enforcedBy}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
                <li className="lp-keyrow lp-keyrow--own">
                  <KeyPlate kind="spend" label="The outline of a key that Holdfast does not hold" className="lp-kp" />
                  <div className="lp-kn">
                    <h3 className="hf-px">Spending key</h3>
                    <p>stays in your wallet</p>
                  </div>
                  <dl className="lp-kd">
                    <div>
                      <dt className="hf-sr">Who holds it</dt>
                      <dd>Every ZEC movement is a payment request the treasurer signs in their own wallet. Holdfast never holds a key that can move the money.</dd>
                    </div>
                  </dl>
                </li>
              </ul>
            </div>
            <div className="lp-paid">
              <div>
                <h3 className="hf-px">Paid on mainnet</h3>
                <p className="lp-paid__intro lp-small">Both paying keys have paid a run inside their limits. Each run is one transaction.</p>
              </div>
              <ul>
                {PAYOUTS.map((payout) => (
                  <li key={payout.run}>
                    <b className="hf-px">
                      {payout.chainName}, run {payout.run}
                    </b>
                    <p>{payout.lines.join(' + ')} USDC, in one transaction.</p>
                    <p>
                      <ExternalTxLink chain={payout.chain} id={payout.tx} showChain={false} />
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* What it cannot do */}
        <section className="lp-sec lp-sec--joined hf-ink" id="refused" aria-labelledby="h-refused">
          <div className="lp-in">
            <div className="lp-head">
              <h2 className="hf-px" id="h-refused">
                What the keys were refused
              </h2>
              <p className="lp-lead">
                Each key was pointed at something it must never do, on mainnet. {word(REFUSALS.length - unsigned.length)} answers are quoted as the network returned them, each with the page where it can be checked. The{' '}
                {ORDINALS[REFUSALS.length] ?? 'last'} needs no network: a viewing key cannot sign.
              </p>
            </div>
            {featured !== undefined && (
              <article className="lp-card lp-feat">
                <div className="lp-pic">
                  <ChainPlate variant={0} label="A chain pulled taut, frozen at the moment of the refusal" />
                </div>
                <div className="lp-led">
                  <RefusalLedger refusal={featured} />
                </div>
              </article>
            )}
            <ul className="lp-slips">
              {networked.map((refusal, index) => (
                <li className="lp-card lp-slip" key={refusal.id}>
                  <div className="lp-pic">
                    <KeyPlate kind={refusal.kind} refused seed={index * 13} label={`The ${refusal.who} stopped against a wall`} />
                  </div>
                  <div className="lp-led">
                    <RefusalLedger refusal={refusal} />
                  </div>
                </li>
              ))}
              {unsigned.map((refusal) => (
                <li className="lp-card lp-slip lp-slip--wide" key={refusal.id}>
                  <div className="lp-pic">
                    <KeyPlate kind={refusal.kind} refused seed={39} label={`The ${refusal.who} stopped against a wall`} />
                  </div>
                  <div className="lp-led">
                    <RefusalLedger refusal={refusal} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <Band ground="ink" />

        {/* Would it have held */}
        {data === null ? (
          <section className="lp-sec hf-paper" id="score" aria-labelledby="h-score">
            <div className="lp-in">
              <div className="lp-head">
                <h2 className="hf-px" id="h-score">
                  The scenarios, written down before the first run
                </h2>
              </div>
              <Unavailable reason={`The scorecard could not be computed: ${missing}`} source="market data" />
            </div>
          </section>
        ) : (
          <Scorecard data={data} />
        )}
        <Band ground="paper" />

        {/* The live treasury */}
        <section className="lp-sec hf-ink" id="live" aria-labelledby="h-live">
          <div className="lp-in">
            <div className="lp-head">
              <div>
                <h2 className="hf-px" id="h-live">
                  The demo treasury is on mainnet
                </h2>
                <p className="lp-stamp">
                  <i className="hf-swatch hf-t12" aria-hidden="true" />
                  The payment below was recorded on {RECORDED.on}. The demo shows the current state.
                </p>
              </div>
              <p className="lp-lead">One grant payment: received shielded, hedged on Hyperliquid, written to the journal. Small sums, real transactions.</p>
            </div>
            {data !== null && (
              <figure>
                <div className="lp-pic lp-framed lp-tape">
                  <TapeChart tape={data.tape} soldAt={RECORDED.short.fillPx} />
                </div>
                <figcaption>ZEC, daily closes, March to October 2026. The demo treasury&rsquo;s short was sold at the right-hand end.</figcaption>
              </figure>
            )}
            <div className="lp-livegrid">
              <div>
                <ol className="lp-steps">
                  <li>
                    <span className="lp-steps__n hf-px" aria-hidden="true">
                      1
                    </span>
                    <div>
                      <h3 className="hf-px">Received {RECORDED.received.zec} ZEC, shielded</h3>
                      <p>
                        Read with the viewing key. Its memo: <q>{RECORDED.received.memo}</q>
                      </p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-steps__n hf-px" aria-hidden="true">
                      2
                    </span>
                    <div>
                      <h3 className="hf-px">
                        {RECORDED.margin.zec} ZEC became {RECORDED.margin.usdc} USDC of margin
                      </h3>
                      <p>Converted through {RECORDED.margin.via} onto the treasury&rsquo;s own Hyperliquid account.</p>
                    </div>
                  </li>
                  <li>
                    <span className="lp-steps__n hf-px" aria-hidden="true">
                      3
                    </span>
                    <div>
                      <h3 className="hf-px">
                        Sold {RECORDED.short.zec} ZEC of perpetual at {formatUsd(RECORDED.short.fillPx)}
                      </h3>
                      <p>The controller placed the short through the agent key. It cannot withdraw the margin it trades against.</p>
                    </div>
                  </li>
                </ol>
                <div className="lp-open">
                  <Button href="/demo">Open the live demo treasury</Button>
                  <small>Public and read-only. No login.</small>
                </div>
              </div>
              <div>
                <Suspense fallback={<LiveNowLoading />}>
                  <LiveNow />
                </Suspense>
                <div className="lp-priv">
                  <p>
                    <b>
                      <i className="hf-swatch hf-pat-locked" aria-hidden="true" />
                      Stays private
                    </b>
                    {PRIVACY.private}
                  </p>
                  <p>
                    <b>
                      <i className="hf-swatch hf-pat-limit" aria-hidden="true" />
                      Is public
                    </b>
                    {PRIVACY.public}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
        <Band ground="ink" />

        {/* Open source */}
        <section className="lp-sec hf-paper" id="run" aria-labelledby="h-run">
          <div className="lp-in">
            <div className="lp-head">
              <h2 className="hf-px" id="h-run">
                Run it yourself and check the books
              </h2>
              <p className="lp-lead">Holdfast is open source and self-hostable. The books it shows can be rebuilt from the chains without it.</p>
            </div>
            <div className="lp-rungrid">
              <div>
                <div className="lp-eq">
                  <figure>
                    <div className="lp-pic lp-framed">
                      <KeyPlate kind="view" label="A viewing key" />
                    </div>
                    <figcaption className="hf-px">a viewing key</figcaption>
                  </figure>
                  <span className="lp-eq__op hf-px" aria-hidden="true">
                    +
                  </span>
                  <figure>
                    <div className="lp-pic lp-framed">
                      <ChainPlate flat variant={2} designHeight={44} designWidth={58} label="Chain data" />
                    </div>
                    <figcaption className="hf-px">chain data</figcaption>
                  </figure>
                  <span className="lp-eq__op hf-px" aria-hidden="true">
                    =
                  </span>
                  <figure>
                    <div className="lp-pic lp-framed">
                      <BooksPlate label="The books" />
                    </div>
                    <figcaption className="hf-px">the books</figcaption>
                  </figure>
                </div>
                <p className="lp-eqnote">
                  That is everything <span className="hf-px">verify</span> needs. It holds no key that can spend, and it does not ask Holdfast for the answer.
                </p>
              </div>
              <dl className="lp-defs">
                <div>
                  <dt className="hf-px">Self-host</dt>
                  <dd>The code is open. Run the service on your own machine instead of ours.</dd>
                </div>
                <div>
                  <dt className="hf-px">Auditor link</dt>
                  <dd>A link you can hand to an auditor. It shows the reconciled books.</dd>
                </div>
                <div>
                  <dt className="hf-px">verify</dt>
                  <dd>A command line tool. It re-derives the same books from chain data and a viewing key.</dd>
                </div>
              </dl>
            </div>
            <p className="lp-nots hf-px">
              <span>Not claimed:</span>
              {NOT_CLAIMED.map((item) => (
                <span key={item}>
                  <i className="hf-swatch hf-pat-limit" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot hf-ink">
        <FootBed />
        <div className="lp-in">
          <p className="lp-big hf-px">
            Lock your runway.
            <br />
            Keep your keys.
          </p>
          <Button href="/demo">Open the live demo treasury</Button>
          <div className="lp-fb">
            <NextLink className="lp-wordmark hf-px" href="/" prefetch={false}>
              Holdfast
            </NextLink>
            <nav aria-label="Footer">
              <a className="hf-px" href={DOCS_URL}>
                Docs
              </a>
              <NextLink className="hf-px" href="/demo" prefetch={false}>
                Demo
              </NextLink>
              <a className="hf-px" href={REPOSITORY_URL}>
                GitHub
              </a>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
