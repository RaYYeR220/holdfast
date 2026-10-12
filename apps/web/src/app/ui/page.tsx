import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  BooksPlate,
  Button,
  ChainPlate,
  Checkbox,
  CopyButton,
  DataTable,
  DitherAreaChart,
  ExternalTxLink,
  Input,
  KeyPlate,
  KeyValue,
  Link,
  Notice,
  Panel,
  Plate,
  QrFrame,
  STATES,
  STATE_PATTERN,
  SectionHeading,
  Select,
  Skeleton,
  Sparkline,
  Stat,
  StateTag,
  Tabs,
  Tag,
  Textarea,
  Tick,
  Timestamp,
  Toggle,
  Tooltip,
  Unavailable,
  WorstBars,
  formatPct,
  formatUsd,
} from '@/ui';
import { loadBacktest } from '../_lib/backtest';
import { BusyDemo, CanvasDemo, DialogDemo } from './demos';
import './reference.css';

export const metadata: Metadata = {
  title: 'Design system',
  description: 'Every primitive of the Holdfast interface in every state, on both grounds.',
};

export const dynamic = 'force-dynamic';

/* Transactions on record, used wherever a specimen needs a real one. */
const TEMPO_PAYOUT = '0x379f560f0c9a053e2a1b117fab40ac5d84371c68d188c2583be015eac3fe53e9';
const TEMPO_OVER_LIMIT = '0x2246d81e18fa8269c799855079e7e9ec3cabec80430b62aedd040ab9acb9bce9';
const SOLANA_PAYOUT = '4kLtT81sjyhGt53HsN3YZXAuX5XYLnsXy4Eu3LiaV9PCXFsNkwDxmpovUY3Ww9KHubDtzdyewnCBo8DerfdauYc8';
const SOLANA_OVER_ALLOWANCE = '5UpRY36zNFBVJo6VwRsCUJmnEQbvxs2R1xCZzmSU2RNGBLSUALwWeHPPSH3MKK8ZroXEY3MsuiSaquoZjwQiZq99';
const TEAM_ACCOUNT = '0xC7e7BAAFb0C822d0A934BbB2268F15A7eD8485bc';

/* The address of this repository as a QR code, version 3, level M. */
const REPOSITORY_QR = [
  '#######........#.#....#######',
  '#.....#...##..##.#..#.#.....#',
  '#.###.#.....#..###....#.###.#',
  '#.###.#..#..##.##.#.#.#.###.#',
  '#.###.#..##.#.###.##..#.###.#',
  '#.....#.##.##..##.##..#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '.........##.##.####..........',
  '#..#.##.####..#.##...#.#.....',
  '..#.#....#.###..###.#.#..#..#',
  '##...###.....##..#####..####.',
  '#....#.#.#.#.#..#...#...#.##.',
  '##...###.#.#..#.###..##..#.##',
  '..#.##.##....##..##.##.......',
  '.##.#.##.#...##.#.#.#.#######',
  '###.....#.#....###..###..#.#.',
  '...##.#.###.##...##.#..#...#.',
  '.#.#.#.###.####.#.#.####.#..#',
  '#.##..#..#.#..#.###..#.##..##',
  '...#.#..####..##.#..##.##..##',
  '#.#.#.#.###....##.#######.#..',
  '........#...#.#.#####...#.###',
  '#######..#..#...#.#.#.#.#..#.',
  '#.....#.##.##.#.#...#...###..',
  '#.###.#..##.#..####.#####..##',
  '#.###.#.#.##.......##.######.',
  '#.###.#...#.###.#..##...###.#',
  '#.....#....#..##.#####..#..#.',
  '#######.###....#.#..######.#.',
].map((row) => [...row].map((module) => module === '#'));

interface SpecimenProps {
  name: string;
  /** The import, as it is written in a page. */
  use: string;
  /** When to reach for it, in a sentence or two. */
  children: ReactNode;
  note: ReactNode;
  /** Stack the two grounds instead of setting them side by side: for wide specimens. */
  wide?: boolean;
}

/** One primitive, shown twice: on the ink ground and on the paper ground. */
function Specimen({ name, use, note, wide = false, children }: SpecimenProps) {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return (
    <section className="ref-spec" id={id} aria-labelledby={`${id}-h`}>
      <header className="ref-spec__head">
        <h2 className="hf-px ref-spec__name" id={`${id}-h`}>
          {name}
        </h2>
        <div>
          <p className="ref-spec__note">{note}</p>
          <p className="ref-spec__use">
            <code>{use}</code>
          </p>
        </div>
      </header>
      <div className={wide ? 'ref-grounds ref-grounds--wide' : 'ref-grounds'}>
        <div className="hf-ink ref-ground">
          <p className="hf-px ref-ground__name">Ink ground</p>
          {children}
        </div>
        <div className="hf-paper ref-ground">
          <p className="hf-px ref-ground__name">Paper ground</p>
          {children}
        </div>
      </div>
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ref-row">
      {label !== undefined && <p className="ref-row__label">{label}</p>}
      <div className="ref-row__items">{children}</div>
    </div>
  );
}

const SECTIONS = [
  'Tokens',
  'States',
  'Button',
  'Link',
  'Panel',
  'SectionHeading',
  'Stat',
  'Tag and StateTag',
  'DataTable',
  'KeyValue',
  'Field and inputs',
  'Toggle',
  'Notice',
  'Tabs',
  'Dialog',
  'Tooltip',
  'CopyButton',
  'Skeleton and Unavailable',
  'Timestamp',
  'ExternalTxLink',
  'QrFrame',
  'Charts',
  'DitherCanvas',
  'Drawn objects',
  'AppShell',
];

export default async function UiReference() {
  const now = Date.now();
  const backtest = await loadBacktest();
  const data = backtest.status === 'ok' ? backtest.data : null;
  const june = data?.june ?? null;
  const juneRow = data?.scenarios.find((s) => s.id === 'june-crash') ?? null;

  return (
    <div className="ref hf-ink">
      <header className="ref-top">
        <p className="hf-px ref-top__mark">
          <Link href="/" variant="nav">
            Holdfast
          </Link>
        </p>
        <h1 className="hf-px ref-top__title">Design system</h1>
        <p className="ref-top__lead">
          Every primitive in every state, on both grounds. Pages are built from these and from nothing else. The source of this page is the usage example for each of them:
          <code> src/app/ui/page.tsx</code>.
        </p>
        <ol className="ref-rules">
          <li>
            <strong className="hf-px">Two inks.</strong> Ink <code>#17261F</code> and paper <code>#E9E6D2</code>. No third colour, no opacity, no blur, no rounded corner. A tone is a dither density on a 4px grid.
          </li>
          <li>
            <strong className="hf-px">States are patterns with words.</strong> Locked is solid, unlocked a checker, refused a stair hatch, a limit a dotted outline, stale or unavailable sparse dots. The word is always
            beside the pattern.
          </li>
          <li>
            <strong className="hf-px">The pixel face is for labels.</strong> Headings, labels and short figures only, at 20, 30, 40, 60, 80 or 100px. Sentences are set in the serif; dense figures in the numeric
            face.
          </li>
          <li>
            <strong className="hf-px">Text stands on a solid ground.</strong> Never on a pattern. Contrast between the two inks is 12.5 to 1.
          </li>
          <li>
            <strong className="hf-px">Every figure says when it was read.</strong> A figure that could not be read is shown as unavailable, with the reason. It is never a blank, a zero or an older number.
          </li>
        </ol>
        <nav className="ref-toc" aria-label="Primitives">
          <ul>
            {SECTIONS.map((name) => (
              <li key={name}>
                <a className="hf-link" href={`#${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
                  {name}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="ref-main">
        <Specimen name="Tokens" use="@/ui/tokens.css" note="Custom properties for the inks, the grounds, spacing, rules, focus and the three faces. Wrap a region in .hf-ink or .hf-paper to choose its ground; everything inside draws with --fg on --bg.">
          <Row label="Tones: .hf-t12, .hf-t25, .hf-t50, .hf-t75, and solid">
            <div className="ref-tones">
              {(['hf-t12', 'hf-t25', 'hf-t50', 'hf-t75', 'hf-pat-locked'] as const).map((tone, index) => (
                <figure key={tone}>
                  <i className={`ref-tone ${tone}`} />
                  <figcaption className="hf-px">{['12.5%', '25%', '50%', '75%', '100%'][index]}</figcaption>
                </figure>
              ))}
            </div>
          </Row>
          <Row label="Pixel face: --px-1 to --px-6">
            <div className="ref-type">
              <p className="hf-px" style={{ font: 'var(--px-4) var(--f-px)', fontWeight: 420 }}>
                Runway 60
              </p>
              <p className="hf-px" style={{ font: 'var(--px-3) var(--f-px)', fontWeight: 420 }}>
                Heading 40
              </p>
              <p className="hf-px" style={{ font: 'var(--px-2) var(--f-px)', fontWeight: 420 }}>
                Title 30
              </p>
              <p className="hf-px">Label 20: Lock runway</p>
            </div>
          </Row>
          <Row label="Serif: --tx-xl, --tx-l, --tx-m, --tx-s">
            <div className="ref-type">
              <p style={{ font: 'var(--tx-xl) var(--f-text)' }}>Lead, 24 on 36. The service never holds a key that can move the money.</p>
              <p style={{ font: 'var(--tx-l) var(--f-text)' }}>Page body, 21 on 32. Every ZEC movement is a payment request the treasurer signs.</p>
              <p style={{ font: 'var(--tx-m) var(--f-text)' }}>Product body, 19 on 28. The short gains what the treasury loses.</p>
              <p style={{ font: 'var(--tx-s) var(--f-text)' }}>
                Small print, 17 on 25. <em>Italic for captions and times.</em>
              </p>
            </div>
          </Row>
          <Row label="Numeric face: .hf-num, --num-m, --num-s">
            <div className="ref-type">
              <p style={{ font: 'var(--num-m) var(--f-num)' }}>0.01975 ZEC · 1,226.40 · {TEAM_ACCOUNT}</p>
              <p style={{ font: 'var(--num-s) var(--f-num)' }}>0123456789 · tabular digits for columns</p>
            </div>
          </Row>
          <Row label="Spacing: --s1 to --s28, in steps of the 4px design pixel">
            <div className="ref-space">
              {[4, 8, 12, 16, 20, 24, 32, 40, 48, 72, 96, 112].map((size) => (
                <figure key={size}>
                  <i className="hf-pat-locked" style={{ width: size, height: 16 }} />
                  <figcaption>{size}</figcaption>
                </figure>
              ))}
            </div>
          </Row>
          <Row label="Rules: --rule 4px, --rule-thin 2px, .hf-rule-dot. Focus: a 4px ring, 4px clear">
            <div className="ref-rulelist">
              <hr className="hf-rule" />
              <hr className="hf-rule" style={{ borderTopWidth: 'var(--rule-thin)' }} />
              <div className="hf-rule-dot" style={{ height: 4 }} />
              <p>
                <button type="button" className="ref-focus hf-px">
                  Focused
                </button>
              </p>
            </div>
          </Row>
        </Specimen>

        <Specimen
          name="States"
          use="import { StateTag, Swatch, STATES, stateBit } from '@/ui'"
          note="The five states every product screen distinguishes. CSS classes .hf-pat-locked, -unlocked, -refused, -limit, -stale give the fill; stateBit() and fillState() give the same fill on a canvas."
        >
          <div className="ref-states">
            {STATES.map((state) => (
              <figure key={state}>
                <i className={`ref-state hf-pat-${state}`} />
                <figcaption>
                  <StateTag state={state} />
                  <span className="hf-small">{STATE_PATTERN[state]}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </Specimen>

        <Specimen
          name="Button"
          use="import { Button } from '@/ui'"
          note="One primary action to a view. Secondary for the rest, quiet inside text and dense rows, destructive for what cannot be undone. With href it is a link. Busy and disabled are states of every kind."
        >
          <Row label="Primary, secondary, quiet, destructive">
            <Button>Lock runway</Button>
            <Button variant="secondary">Preview the lock</Button>
            <Button variant="quiet">Show the journal</Button>
            <Button variant="destructive">Revoke the delegate</Button>
          </Row>
          <Row label="Busy">
            <Button busy>Signing</Button>
            <Button variant="secondary" busy>
              Reading the chain
            </Button>
            <Button variant="destructive" busy>
              Revoking
            </Button>
            <BusyDemo />
          </Row>
          <Row label="Disabled">
            <Button disabled>Lock runway</Button>
            <Button variant="secondary" disabled>
              Preview the lock
            </Button>
            <Button variant="quiet" disabled>
              Show the journal
            </Button>
            <Button variant="destructive" disabled>
              Revoke the delegate
            </Button>
          </Row>
          <Row label="Small, for table rows and panel heads">
            <Button small>Pay the run</Button>
            <Button variant="secondary" small>
              Preview
            </Button>
            <Button variant="quiet" small>
              Details
            </Button>
            <Button variant="destructive" small>
              Revoke
            </Button>
          </Row>
          <Row label="As links">
            <Button href="/demo">Open the live demo treasury</Button>
            <Button variant="secondary" href="https://github.com/RaYYeR220/holdfast#readme" external>
              Read the docs
            </Button>
          </Row>
        </Specimen>

        <Specimen name="Link" use="import { Link } from '@/ui'" note="A dotted underline. The text variant sits in a sentence, emphasis is the italic call to action, nav is a pixel label on a plate. External links open in a new tab and carry the arrow.">
          <Row>
            <p>
              The books can be rebuilt from the chains; see <Link href="/demo">the demo treasury</Link> or read <Link href="https://github.com/RaYYeR220/holdfast#readme" external>the documentation</Link>.
            </p>
          </Row>
          <Row label="Emphasis">
            <Link href="/#refused" variant="emphasis">
              See a withdrawal refused
            </Link>
          </Row>
          <Row label="Nav, and the current page">
            <Link href="/demo" variant="nav">
              Demo
            </Link>
            <Link href="/ui" variant="nav" current>
              Design system
            </Link>
          </Row>
        </Specimen>

        <Specimen name="Panel" use="import { Panel, Plate } from '@/ui'" note="A framed region. Give it a title, a state, an aside and a foot as needed. Framed doubles the border for the one panel a view is about; inverse puts it on the other ground. Plate is the ink plate pictures are printed on.">
          <div className="ref-cols">
            <Panel title="Hedge" state="locked" stateLabel="Lock on" foot={<>Read from Hyperliquid.</>}>
              <p>The short is sized to the treasury. When ZEC falls, the short gains what the treasury loses.</p>
            </Panel>
            <Panel title="Payout limit" state="limit" aside={<Button variant="quiet" small>Change</Button>}>
              <p>The access key pays up to a periodic limit. The chain enforces it.</p>
            </Panel>
            <Panel title="Framed" framed>
              <p>A double frame, for the one thing a view is about.</p>
            </Panel>
            <Panel title="Inverse" inverse state="unlocked" stateLabel="Lock off">
              <p>The same panel on the other ground.</p>
            </Panel>
          </div>
        </Specimen>

        <Specimen name="SectionHeading" use="import { SectionHeading } from '@/ui'" note="A heading that says what the section shows, with a sentence beside it. Size page for the one heading of a page, section for its parts, minor inside a panel." wide>
          <SectionHeading level={3} size="page" kicker="Demo treasury" title="Overview" lead="What the treasury holds, how much of it is locked and when each figure was read." />
          <SectionHeading level={3} title="What the keys were refused" lead="Each key was pointed at something it must never do." rule />
          <SectionHeading level={3} size="minor" title="Controller journal" />
        </Specimen>

        <Specimen name="Stat" use="import { Stat } from '@/ui'" note="One figure, its label and the time it was read. Pass unavailable instead of figure when the read failed: the reason takes the figure's place.">
          <div className="ref-cols">
            <Stat label="Fill price" figure={formatUsd(1226.4)} asOf={now - 3 * 60_000} now={now} source="Hyperliquid" />
            <Stat label="Margin ratio" figure="90%" state="locked" note="Equity over the notional of the short." asOf={now - 42_000} now={now} />
            <Stat size="large" label="Worst point, locked" figure={juneRow === null ? '−0.9%' : formatPct(juneRow.lockedWorstPct)} note="June 2026, against the value on June 1." />
            <Stat size="small" label="Received" figure="0.01975" unit="ZEC" />
            <Stat label="Treasury" unavailable={{ reason: 'no tick has run for this organisation yet', source: 'zcash', at: now - 60_000 }} now={now} />
          </div>
        </Specimen>

        <Specimen name="Tag and StateTag" use="import { Tag, StateTag, Tick } from '@/ui'" note="Tag is a short pixel label: a chain, a mode. StateTag is a state as pattern and word; pass label to say it in the screen's own words.">
          <Row label="Tag: plain, boxed, solid">
            <Tag variant="plain">Tempo</Tag>
            <Tag>mainnet</Tag>
            <Tag variant="solid">REBALANCE</Tag>
          </Row>
          <Row label="StateTag, default words">
            {STATES.map((state) => (
              <StateTag key={state} state={state} />
            ))}
          </Row>
          <Row label="StateTag, the screen's own words, boxed">
            <StateTag state="locked" label="Lock on" boxed />
            <StateTag state="unlocked" label="Lock off" boxed />
            <StateTag state="refused" label="Reverted" boxed />
            <StateTag state="limit" label="At the limit" boxed />
            <StateTag state="stale" label="Stale" boxed />
          </Row>
          <Row label="Tick: a criterion met">
            <span className="hf-tag">
              <Tick />4 of 4 met
            </span>
          </Row>
        </Specimen>

        <Specimen name="DataTable" use="import { DataTable } from '@/ui'" note="Dense rows. Text in the serif, figures right-aligned in the numeric face. A row can carry a state: it starts with the pattern and the word. The table scrolls sideways in its own region on a narrow screen." wide>
          <DataTable
            caption="The nine scenarios, worst point against the starting value"
            columns={[
              { key: 'scenario', header: 'Scenario', rowHeader: true },
              { key: 'locked', header: 'Locked', numeric: true },
              { key: 'unlocked', header: 'Unlocked', numeric: true },
              { key: 'topUps', header: 'Top-ups', numeric: true },
              { key: 'buyBacks', header: 'Buy-backs', numeric: true },
              { key: 'ends', header: 'Ends hedged', numeric: true },
            ]}
            rows={(data?.scenarios ?? []).map((s) => ({
              id: s.id,
              state: s.control ? ('refused' as const) : ('locked' as const),
              stateLabel: s.control ? 'Lock failed' : 'Held',
              cells: {
                scenario: s.title,
                locked: formatPct(s.lockedWorstPct),
                unlocked: formatPct(s.unlockedWorstPct),
                topUps: s.topUps,
                buyBacks: s.buyBacks,
                ends: `${s.endCoveragePct}%`,
              },
            }))}
            empty="The backtest is unavailable."
          />
          <Row label="Dense, without states, and empty">
            <div className="ref-cols">
              <DataTable
                dense
                caption="Payouts on record"
                columns={[
                  { key: 'run', header: 'Run', rowHeader: true },
                  { key: 'chain', header: 'Chain' },
                  { key: 'total', header: 'USDC', numeric: true },
                ]}
                rows={[
                  { id: '1', cells: { run: 'HF-2026-10-0001', chain: 'Tempo', total: '0.75' } },
                  { id: '3', cells: { run: 'HF-2026-10-0003', chain: 'Solana', total: '0.75' } },
                ]}
              />
              <DataTable caption="Refusals" columns={[{ key: 'a', header: 'Attempted' }, { key: 'b', header: 'Outcome' }]} rows={[]} empty="No refusal is on record for this organisation." />
            </div>
          </Row>
        </Specimen>

        <Specimen name="KeyValue" use="import { KeyValue } from '@/ui'" note="The facts of one thing, each on a dotted rule. Stacked puts each value under its label, for narrow panels and long values.">
          <div className="ref-cols">
            <KeyValue
              items={[
                { label: 'Key', value: 'Agent key' },
                { label: 'Chain', value: 'Hyperliquid' },
                { label: 'Can', value: 'Place and cancel ZEC perpetual orders' },
                { label: 'Cannot', value: 'Withdraw or transfer' },
                { label: 'Enforced by', value: 'The exchange' },
              ]}
            />
            <KeyValue
              stacked
              items={[
                { label: 'Team account', value: <CopyButton value={TEAM_ACCOUNT} what="address">{TEAM_ACCOUNT}</CopyButton> },
                { label: 'Run', value: 'HF-2026-10-0001' },
              ]}
            />
          </div>
        </Specimen>

        <Specimen name="Field and inputs" use="import { Input, Textarea, Select, Checkbox, Field } from '@/ui'" note="Each control carries its own label, hint and error. An error frames the control in the hatch and is announced. Use Field directly around a control of your own.">
          <div className="ref-cols">
            <Input label="Organisation name" defaultValue="Holdfast Demo" />
            <Input label="Monthly costs" hint="In dollars. Used to say how many months the treasury covers." placeholder="for example 12000" numeric inputMode="decimal" />
            <Input label="Payee address" numeric defaultValue="0xC7e7BAAFb0C822d0A934" error="This is not an address: it is 22 characters, an address is 42." />
            <Input label="Viewing key" defaultValue="Stored encrypted. Not shown again." disabled />
            <Select
              label="Pay on"
              defaultValue="tempo"
              options={[
                { value: 'tempo', label: 'Tempo' },
                { value: 'solana', label: 'Solana' },
              ]}
            />
            <Select label="Token" defaultValue="" error="Choose the token the run is paid in." options={[{ value: '', label: 'Choose a token' }, { value: 'usdc', label: 'USDC' }]} />
            <Textarea label="Memo" hint="Written into the payment request the treasurer signs." defaultValue="ZCG grant, milestone 2 of 4" />
            <div className="ref-checks">
              <Checkbox label="I have saved the viewing key somewhere else" defaultChecked />
              <Checkbox label="Make this treasury a public demo" hint="Anyone can read it. Nobody can change it." />
              <Checkbox label="Unavailable until a key is approved" disabled />
            </div>
          </div>
        </Specimen>

        <Specimen name="Toggle" use="import { Toggle } from '@/ui'" note="A lever with both positions written on it. The position in force is the solid half. It differs in word, in pattern and in place, never in colour.">
          <Row>
            <Toggle label="Lock runway" defaultChecked />
            <Toggle label="Lock runway" />
          </Row>
          <Row label="Small, and disabled">
            <Toggle label="Public demo" small offLabel="No" onLabel="Yes" />
            <Toggle label="Lock runway" disabled />
          </Row>
        </Specimen>

        <Specimen name="Notice" use="import { Notice } from '@/ui'" note="A message set apart from the page. The band and the word in the title say which kind: Note, Warning or Refused. Refusals quote what the chain or the venue answered.">
          <div className="ref-stack">
            <Notice title="The demo is read only">Anyone can read this treasury. Nobody can change it from here.</Notice>
            <Notice kind="warning" title="A top-up request is waiting">
              A lock needs margin top-ups in a strong rally. An ignored lock in a doubling is worse than no lock.
            </Notice>
            <Notice kind="refusal" title="SpendingLimitExceeded">
              <p>The access key tried to pay above its limit. The transaction was included and reverted by the chain.</p>
              <p>
                <ExternalTxLink chain="tempo" id={TEMPO_OVER_LIMIT} />
              </p>
            </Notice>
          </div>
        </Specimen>

        <Specimen name="Tabs" use="import { Tabs } from '@/ui'" note="Views of one thing. Arrow keys move between tabs, Home and End jump to the ends. The selected tab is the solid one.">
          <Tabs
            label="Payout rails"
            items={[
              { id: 'tempo', label: 'Tempo', content: <p>An access key with a periodic limit. The chain checks expiry, limit and call scope on every transaction the key signs.</p> },
              { id: 'solana', label: 'Solana', content: <p>A token delegate with a fixed allowance, on one token account. After a revoke it can move nothing.</p> },
              { id: 'zcash', label: 'Zcash', content: <p>A viewing key. It reads what the treasury received and cannot sign.</p> },
            ]}
          />
        </Specimen>

        <Specimen name="Dialog" use="import { Dialog } from '@/ui'" note="A sheet of paper over the page held at half tone. Focus stays inside, Escape closes it and focus returns to the button that opened it. It is paper on either ground.">
          <Row>
            <DialogDemo />
          </Row>
        </Specimen>

        <Specimen name="Tooltip" use="import { Tooltip } from '@/ui'" note="A short explanation of a term, on hover and on keyboard focus. Never the only place something needed is said.">
          <Row>
            <p>
              The <Tooltip tip="Equity on the account divided by the notional of the short.">margin ratio</Tooltip> is read from the venue; the{' '}
              <Tooltip tip="The share of the treasury the short covers." placement="below">
                coverage
              </Tooltip>{' '}
              needs the treasury and the venue both.
            </p>
          </Row>
        </Specimen>

        <Specimen name="CopyButton" use="import { CopyButton } from '@/ui'" note="Copies a value and says that it did. Show the value beside it in the numeric face, or leave the children out for a bare button.">
          <Row>
            <CopyButton value={TEAM_ACCOUNT} what="address">
              {TEAM_ACCOUNT}
            </CopyButton>
          </Row>
          <Row label="Bare">
            <CopyButton value={SOLANA_PAYOUT} what="signature" />
          </Row>
        </Specimen>

        <Specimen name="Skeleton and Unavailable" use="import { Skeleton, Unavailable } from '@/ui'" note="Skeleton stands in while a value is being read. Unavailable is the designed state of a value that could not be read: it names the source, gives the reason and the time of the attempt.">
          <div className="ref-cols">
            <div className="ref-stack">
              <Skeleton width="60%" height={44} label="Reading the treasury" />
              <Skeleton />
              <Skeleton width="80%" />
            </div>
            <Unavailable reason="DATABASE_URL is not set" source="database" at={now - 5_000} now={now} />
            <Unavailable word="Stale" reason="the venue state is 412 s old, over the 300 s allowed" source="hyperliquid" at={now - 412_000} now={now} />
            <p>
              Coverage: <Unavailable inline reason="the treasury could not be read" />
            </p>
          </div>
        </Specimen>

        <Specimen name="Timestamp" use="import { Timestamp } from '@/ui'" note="A moment, absolute in UTC and relative. Pass the server's clock as now so the first paint is right; the browser keeps it current.">
          <Row label="Both, absolute, relative">
            <Timestamp at={now - 3 * 60_000} now={now} />
            <Timestamp at={now - 26 * 3_600_000} now={now} show="absolute" />
            <Timestamp at={now - 44_000} now={now} show="relative" />
          </Row>
        </Specimen>

        <Specimen name="ExternalTxLink" use="import { ExternalTxLink, explorerTxUrl } from '@/ui'" note="A transaction on its chain's explorer. One address pattern for each chain; the link names the chain and shows both ends of the id.">
          <div className="ref-stack">
            <ExternalTxLink chain="tempo" id={TEMPO_PAYOUT} />
            <ExternalTxLink chain="solana" id={SOLANA_OVER_ALLOWANCE} />
            <ExternalTxLink chain="solana" id={SOLANA_PAYOUT} showChain={false}>
              Run HF-2026-10-0003
            </ExternalTxLink>
          </div>
          <Row label="Explorer of each chain">
            <KeyValue
              stacked
              items={[
                { label: 'Zcash', value: <span className="hf-num">mainnet.zcashexplorer.app/transactions/&lt;txid&gt;</span> },
                { label: 'Hyperliquid', value: <span className="hf-num">app.hyperliquid.xyz/explorer/tx/&lt;hash&gt;</span> },
                { label: 'Tempo', value: <span className="hf-num">explore.tempo.xyz/tx/&lt;hash&gt;</span> },
                { label: 'Solana', value: <span className="hf-num">solscan.io/tx/&lt;signature&gt;</span> },
              ]}
            />
          </Row>
        </Specimen>

        <Specimen name="QrFrame" use="import { QrFrame } from '@/ui'" note="A boolean matrix as one-bit modules in a double frame. Always ink on paper so it scans. Encoding the payload is the caller's work; this one holds the address of the repository.">
          <Row>
            <QrFrame matrix={REPOSITORY_QR} label="QR code of github.com/RaYYeR220/holdfast" caption="The repository. Module size 4px." />
            <QrFrame matrix={REPOSITORY_QR} moduleSize={8} label="QR code of github.com/RaYYeR220/holdfast" caption="Module size 8px, for scanning from a distance." />
          </Row>
        </Specimen>

        <Specimen name="Charts" use="import { DitherAreaChart, Sparkline, WorstBars } from '@/ui'" note="Driven by plain arrays. The area is the series that moves, in the checker; the line is the series held, solid. Series are named at their ends and in the legend, never by fill alone." wide>
          {june === null || juneRow === null ? (
            <Unavailable reason={backtest.status === 'unavailable' ? backtest.reason : 'the backtest has no June scenario'} source="market data" />
          ) : (
            <div className="ref-cols ref-cols--chart">
              <DitherAreaChart
                label={`One treasury through June 1 to 15, 2026. Unlocked it falls ${formatPct(june.unlockedWorstPct)} at worst; locked it stays within ${formatPct(june.lockedWorstPct)}.`}
                area={{ label: 'Unlocked', values: june.points.map((p) => p.unlockedPct), endLabel: `Unlocked, worst ${formatPct(june.unlockedWorstPct)}` }}
                line={{ label: 'Locked', values: june.points.map((p) => p.lockedPct), endLabel: `Locked, worst ${formatPct(june.lockedWorstPct)}` }}
                fillBetween
                domain={[-100, 16]}
                ticks={[
                  { at: 0, label: 'June 1' },
                  { at: 4 / 14, label: '5' },
                  { at: 9 / 14, label: '10' },
                  { at: 1, label: 'June 15' },
                ]}
                caption="DitherAreaChart with two series and fillBetween: the solid region is what the lock held."
              />
              <div className="ref-stack">
                <div>
                  <p className="ref-row__label">WorstBars</p>
                  <WorstBars
                    scale={50}
                    bars={[
                      { label: 'Locked', value: juneRow.lockedWorstPct, text: formatPct(juneRow.lockedWorstPct), state: 'locked' },
                      { label: 'Unlocked', value: juneRow.unlockedWorstPct, text: formatPct(juneRow.unlockedWorstPct), state: 'unlocked' },
                    ]}
                  />
                </div>
                <div>
                  <p className="ref-row__label">Sparkline: ZEC, daily closes, March to October 2026</p>
                  <p>
                    <Sparkline values={(data?.tape.points ?? []).map((p) => p.px)} label="ZEC daily closes, March to October 2026" columns={64} rows={10} filled />
                  </p>
                  <p style={{ marginTop: 12 }}>
                    In a row at unit 2: <Sparkline values={june.points.map((p) => p.px)} label="ZEC through June 1 to 15, 2026" columns={48} rows={10} unit={2} /> June 1 to 15.
                  </p>
                </div>
              </div>
            </div>
          )}
        </Specimen>

        <Specimen
          name="DitherCanvas"
          use="import { DitherCanvas, Raster } from '@/ui'"
          note="The canvas for drawings made from data. Give it a draw function that returns a Raster; it measures the box, holds one canvas pixel to a design pixel whatever the device pixel ratio, pauses off screen and draws a still frame when motion is reduced. Labels are real text set over the plate."
        >
          <Plate framed>
            <CanvasDemo />
          </Plate>
        </Specimen>

        <Specimen name="Drawn objects" use="import { KeyPlate, ChainPlate, BooksPlate } from '@/ui'" note="The keys, a chain pulled taut and the books. The bow tells the keys apart: an eye, a ring, a square, a diamond. The spending key is an outline, because Holdfast does not hold it." wide>
          <div className="ref-objects">
            {(
              [
                ['view', 'Viewing key'],
                ['agent', 'Agent key'],
                ['access', 'Access key'],
                ['delegate', 'Token delegate'],
                ['spend', 'Spending key'],
              ] as const
            ).map(([kind, label]) => (
              <figure key={kind}>
                <Plate>
                  <KeyPlate kind={kind} label={`${label}, drawn as a key`} className="ref-object" />
                </Plate>
                <figcaption className="hf-px">{label}</figcaption>
              </figure>
            ))}
            <figure>
              <Plate>
                <KeyPlate kind="access" refused label="The access key stopped against a wall" className="ref-object" />
              </Plate>
              <figcaption className="hf-px">Refused</figcaption>
            </figure>
            <figure>
              <Plate>
                <ChainPlate flat designHeight={44} designWidth={58} variant={2} label="A level chain" className="ref-object" />
              </Plate>
              <figcaption className="hf-px">Chain</figcaption>
            </figure>
            <figure>
              <Plate>
                <BooksPlate label="The books" className="ref-object" />
              </Plate>
              <figcaption className="hf-px">Books</figcaption>
            </figure>
          </div>
        </Specimen>

        <section className="ref-spec" id="appshell" aria-labelledby="appshell-h">
          <header className="ref-spec__head">
            <h2 className="hf-px ref-spec__name" id="appshell-h">
              AppShell
            </h2>
            <div>
              <p className="ref-spec__note">
                The frame of both product areas: a rail of the seven sections, a header that names the organisation and says who is looking, and a paper page. It is in use at <Link href="/demo">/demo</Link>. Under 1000px the rail
                becomes a strip that scrolls sideways.
              </p>
              <p className="ref-spec__use">
                <code>import {'{ AppShell }'} from &apos;@/ui&apos;</code>
              </p>
              <p className="ref-spec__note">
                A page inside the shell is a <code>SectionHeading size=&quot;page&quot;</code> followed by panels. The helpers <code>.hf-grid .hf-grid--2/3/4</code> and <code>.hf-stack</code> lay them out and collapse on narrow
                screens.
              </p>
            </div>
          </header>
        </section>
      </main>
    </div>
  );
}
