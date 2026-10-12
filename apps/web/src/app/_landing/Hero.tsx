'use client';

import NextLink from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, ChainPlate, DitherCanvas, type DitherGrid } from '@/ui';
import { type Cloud, type Kelp, type Rect, type Rock, type Scene, type SceneLayout, buildScene } from '@/ui/onebit/scene';
import { RefusalLedger } from './RefusalLedger';
import { DOCS_URL, HERO_KEYS, REFUSALS } from './facts';

/**
 * The hero: a ship held by a chain to an anchor, with the claim set against
 * it. On a wide screen the first line of the claim rests on the waterline
 * beside the ship and the second hangs under it, level with the first of the
 * three keys on the chain. On a narrow one the whole claim sits under the
 * water and the chain runs down the edge.
 *
 * The stylesheet decides the size of a design pixel, the height of the hero
 * and the row of the waterline; this component reads them back, measures the
 * text and lays the picture out around it.
 */

interface KeyBox {
  section: number;
  /** The pressable area, in CSS pixels from the hero's corner. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Where the label's centre line sits inside the area. */
  labelTop: number;
}

const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });

export function Hero() {
  const hero = useRef<HTMLElement>(null);
  const waterline = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const line1 = useRef<HTMLSpanElement>(null);
  const line2 = useRef<HTMLSpanElement>(null);
  const sentence = useRef<HTMLParagraphElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const resume = useRef<HTMLButtonElement>(null);

  const scene = useRef<{ key: string; scene: Scene } | null>(null);
  const [unit, setUnit] = useState(4);
  const [fonts, setFonts] = useState(0);
  const [keys, setKeys] = useState<KeyBox[]>([]);
  const [roomy, setRoomy] = useState(false);
  const [hot, setHot] = useState(-1);
  const [flash, setFlash] = useState(false);
  const [moment, setMoment] = useState<number | null>(null);
  const triedId = useId();
  const answerId = useId();

  // The size of a design pixel is the stylesheet's to choose; follow it.
  useEffect(() => {
    const read = () => {
      const element = hero.current;
      if (element === null) return;
      const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--u'));
      if (Number.isFinite(value) && value > 0) setUnit(value);
    };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  // The picture is laid out around the text, so it is laid out again once the faces have loaded.
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setFonts((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  const layoutFor = useCallback((W: number, H: number, U: number): SceneLayout | null => {
    const root = hero.current;
    const mark = waterline.current;
    if (root === null || mark === null) return null;
    const origin = root.getBoundingClientRect();
    const boxOf = (element: HTMLElement | null): Rect => {
      if (element === null) return { x0: 0, y0: 0, x1: 0, y1: 0 };
      const r = element.getBoundingClientRect();
      return { x0: (r.left - origin.left) / U, y0: (r.top - origin.top) / U, x1: (r.right - origin.left) / U, y1: (r.bottom - origin.top) / U };
    };
    const style = getComputedStyle(root);
    const straddle = style.getPropertyValue('--straddle').trim() === '1';
    const WL = Math.round(mark.offsetTop / U);
    const compact = W * U <= 760;

    if (straddle) {
      const l1 = boxOf(line1.current);
      const l2 = boxOf(line2.current);
      const rest = union(boxOf(sentence.current), boxOf(actions.current));
      const gap = 16;
      const marginRight = Math.max(8, Math.round(W * 0.03));
      const topClear = Math.ceil(boxOf(bar.current).y1) + 3;
      const room = W - marginRight - (l1.x1 + gap);
      const k = Math.max(0.6, Math.min(1.3, (WL - topClear) / 74, room / 128));
      const spare = Math.max(0, room - 128 * k);
      const ox = Math.round(l1.x1 + gap + 53 * k + spare * 0.5);
      const mr = Math.round(36 * k);
      const mx = ox - Math.round(3 * k);
      const hawse = ox + 44.5 * k;
      const anchorLength = Math.round(Math.max(26, Math.min(40, (H - WL) * 0.3)));
      // How far apart three keys can hang between the surface and the anchor's ring decides how large they are drawn.
      const spacing = (H - 17 - anchorLength * 0.883 - WL - 22) / 2;
      const keyScale = spacing >= 19 ? 0.8 : spacing >= 14.5 ? 0.6 : 0;
      // The anchor leans to the right of its ring by four fifths of its length; keep all of it in the picture.
      const ax = Math.round(Math.min(W - anchorLength * 0.8 - 10, hawse + 10 + spare * 0.25));
      const calmX = Math.round(Math.max(l2.x1, rest.x1) + 12);
      const rocks: Rock[] = [[Math.round(ox - 34 * k), 7, 4], [Math.round(W * 0.055), 6, 3]];
      const kelp: Kelp[] = [[Math.round(ox - 34 * k) - 2, 17], [Math.round(ox - 34 * k) + 4, 10], [Math.round(W * 0.055) - 1, 12], [Math.round(W * 0.055) + 4, 7]];
      if (W - (ax + anchorLength * 0.8) > 30) {
        rocks.push([W - 10, 9, 7]);
        kelp.push([W - 13, 38], [W - 7, 24], [W - 3, 14]);
      }
      const clouds: Cloud[] = [
        [mx - mr * 2.5, WL - 13, 58, 2.2, 0.75],
        [mx - mr * 3.6, WL - 27, 70, 1.8, 0.5],
        [mx + mr * 2.3, WL - 19, 44, 2, 0.75],
        [mx - mr * 5.6, WL - 9, 60, 1.6, 0.25],
        [mx - mr * 2.9, WL - 46, 46, 1.5, 0.25],
        [mx + mr * 2.9, WL - 40, 30, 1.4, 0.5],
        [mx - mr * 6.4, WL - 36, 54, 1.4, 0.125],
        [mx + mr * 3.4, WL - 7, 34, 1.4, 0.5],
        [mx - mr * 4.4, WL - 64, 44, 1.3, 0.125],
        [mx + mr * 2.7, WL - 60, 24, 1.2, 0.25],
      ];
      return {
        kind: 'ship',
        w: W,
        h: H,
        waterline: WL,
        compact: false,
        k,
        ox,
        moon: { x: mx, y: WL - Math.round(41 * k), r: mr },
        clouds,
        rocks,
        kelp,
        anchor: { x: ax, length: anchorLength, mirrored: false },
        chainCurve: 1.9,
        calmX,
        quiet: [
          { x0: l1.x0 - 4, y0: l1.y0 + 3, x1: l1.x1 + 5, y1: WL - 1 },
          { x0: l2.x0 - 4, y0: WL + 6, x1: l2.x1 + 6, y1: l2.y1 },
          { x0: rest.x0 - 4, y0: rest.y0 - 2, x1: rest.x1 + 6, y1: rest.y1 + 3 },
        ],
        keyScale,
      };
    }

    // The stacked composition: the ship above the claim, the chain down the right-hand side.
    const mid = !compact && W * U < 1200;
    const k = compact ? 0.7 : Math.min(1, (WL - 13) / 74, W / 250);
    const text = union(union(boxOf(line1.current), boxOf(line2.current)), union(boxOf(sentence.current), boxOf(actions.current)));
    const ox = compact ? W - 41 : mid ? Math.min(Math.round(W * 0.7), Math.round(W - 76 * k - 3)) : Math.round(W * 0.655);
    const mr = Math.round(36 * k);
    const mx = ox - Math.round(3 * k);
    const hawse = Math.round(ox + 44.5 * k);
    const rightRock = Math.round(W * 0.966);
    return {
      kind: 'ship',
      w: W,
      h: H,
      waterline: WL,
      compact,
      k,
      ox,
      moon: { x: mx, y: WL - Math.round(41 * k), r: mr },
      clouds: compact
        ? [
            [18, WL - 9, 26, 1.6, 0.5],
            [30, WL - 22, 20, 1.3, 0.25],
            [8, WL - 34, 16, 1.2, 0.25],
            [W - 4, WL - 15, 12, 1.4, 0.5],
          ]
        : [
            [mx - mr * 2.5, WL - 13, 58, 2.2, 0.75],
            [mx - mr * 3.6, WL - 27, 70, 1.8, 0.5],
            [mx + mr * 2.3, WL - 19, 44, 2, 0.75],
            [mx - mr * 5.6, WL - 9, 60, 1.6, 0.25],
            [mx - mr * 2.9, WL - 46, 46, 1.5, 0.25],
            [mx + mr * 2.9, WL - 40, 30, 1.4, 0.5],
            [mx - mr * 6.4, WL - 36, 54, 1.4, 0.125],
            [mx + mr * 3.4, WL - 7, 34, 1.4, 0.5],
          ],
      rocks: compact ? [[9, 7, 4]] : mid ? [[rightRock, 6, 5]] : [[rightRock, 8, 7], [Math.round(W * 0.735), 6, 3]],
      kelp: compact ? [[7, 13], [11, 8]] : mid ? [[rightRock - 3, 30], [rightRock + 3, 18]] : [[rightRock - 4, 40], [rightRock + 3, 25], [Math.round(W * 0.735) - 1, 13]],
      anchor: { x: compact ? hawse - 1 : mid ? Math.min(W - 22, hawse + 5) : Math.round(W * 0.832), length: compact ? 26 : 32, mirrored: compact },
      chainCurve: compact ? 1.2 : 1.9,
      calmX: compact ? W - 17 : Math.round(W * 0.62),
      quiet: [{ x0: text.x0 - 4, y0: text.y0 + 2, x1: text.x1 + 5, y1: text.y1 + 3 }],
      keyScale: 0,
    };
  }, []);

  const draw = useCallback(
    (grid: DitherGrid) => {
      const key = `${grid.w}x${grid.h}@${grid.unit}:${fonts}`;
      if (scene.current === null || scene.current.key !== key) {
        const layout = layoutFor(grid.w, grid.h, grid.unit);
        if (layout === null) return new Uint8Array(grid.w * grid.h);
        const built = buildScene(layout);
        scene.current = { key, scene: built };
        const U = grid.unit;
        const boxes: KeyBox[] = [];
        for (let section = 0; section < 3; section++) {
          const links = built.links.filter((link) => link.section === section);
          if (links.length === 0) continue;
          let area: Rect = {
            x0: Math.min(...links.map((l) => l.x)) - 6,
            y0: Math.min(...links.map((l) => l.y)) - 3,
            x1: Math.max(...links.map((l) => l.x)) + 6,
            y1: Math.max(...links.map((l) => l.y)) + 3,
          };
          const hung = built.keys.find((item) => item.section === section);
          if (hung !== undefined) area = union(area, { x0: hung.box.x0 - 2, y0: hung.box.y0 - 2, x1: hung.box.x1, y1: hung.box.y1 + 2 });
          const centre = hung === undefined ? (area.y0 + area.y1) / 2 : hung.bowY;
          boxes.push({ section, left: area.x0 * U, top: area.y0 * U, width: (area.x1 - area.x0) * U, height: (area.y1 - area.y0) * U, labelTop: (centre - area.y0) * U });
        }
        setKeys(boxes);
        // Each label is two lines when the keys hang far enough apart for both, and one when they do not.
        const [first, second] = built.keys;
        const apart = first === undefined || second === undefined ? 0 : (second.bowY - first.bowY) * U;
        setRoomy(apart >= (U >= 6 ? 102 : 74));
      }
      return scene.current.scene.render(grid.frame, hot);
    },
    [fonts, hot, layoutFor],
  );

  /* The frozen moment: the picture flashes to its negative and stops, and the refusal is laid over it on a backdrop that holds the page at half tone. */
  const open = (section: number) => {
    const show = () => {
      setFlash(false);
      setMoment(section);
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      show();
      return;
    }
    setFlash(true);
    window.setTimeout(show, 110);
  };
  const close = () => {
    if (dialog.current?.open === true) dialog.current.close();
  };
  // The dialog opens once its content is in place, so focus lands on its first button.
  useEffect(() => {
    if (moment === null || dialog.current === null || dialog.current.open) return;
    dialog.current.showModal();
    resume.current?.focus();
  }, [moment]);

  const shown = moment === null ? null : (REFUSALS.find((refusal) => refusal.id === HERO_KEYS[moment]?.refusal) ?? null);

  return (
    <header className="lp-hero hf-ink" id="top" ref={hero} data-labels={roomy ? 'full' : 'short'}>
      <DitherCanvas draw={draw} fps={8} unit={unit} cover invert={flash} paused={moment !== null} className="lp-hero__scene" />
      <i className="lp-hero__waterline" ref={waterline} aria-hidden="true" />

      <div className="lp-bar" ref={bar}>
        <NextLink className="lp-wordmark hf-px" href="/" prefetch={false}>
          Holdfast
        </NextLink>
        <nav aria-label="Primary">
          <a className="hf-px" href={DOCS_URL}>
            Docs
          </a>
          <NextLink className="hf-px" href="/demo" prefetch={false}>
            Demo
          </NextLink>
        </nav>
      </div>

      <div className="lp-title">
        <h1 className="hf-px">
          <span ref={line1}>Lock your runway.</span> <span ref={line2}>Keep your keys.</span>
        </h1>
        <p className="lp-sentence" ref={sentence}>
          Holdfast fixes the dollar value of a ZEC treasury and pays your team in stablecoins, using only keys that cannot take your treasury.
        </p>
        <div className="lp-acts" ref={actions}>
          <Button href="/demo">Open the live demo treasury</Button>
          <a className="hf-link hf-link--emphasis" href="#refused">
            See a withdrawal refused
          </a>
        </div>
      </div>

      <div className="lp-keys">
        {keys.map((box) => {
          const key = HERO_KEYS[box.section];
          if (key === undefined) return null;
          return (
            <button
              key={box.section}
              type="button"
              className="lp-key"
              style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
              aria-label={`${key.name}: ${key.sub}. Show it refused.`}
              onMouseEnter={() => setHot(box.section)}
              onMouseLeave={() => setHot((now) => (now === box.section ? -1 : now))}
              onFocus={() => setHot(box.section)}
              onBlur={() => setHot((now) => (now === box.section ? -1 : now))}
              onClick={() => open(box.section)}
            >
              <span className="lp-key__label" aria-hidden="true" style={{ top: box.labelTop }}>
                <b className="hf-px">{key.name}</b>
                <i>{key.sub}</i>
              </span>
            </button>
          );
        })}
      </div>

      <dialog
        ref={dialog}
        className="lp-moment"
        aria-labelledby={answerId}
        aria-describedby={triedId}
        onClose={() => setMoment(null)}
        onClick={(event) => {
          if (event.target === dialog.current) close();
        }}
      >
        {shown !== null && moment !== null && (
          <div className="lp-card">
            <div className="lp-pic lp-moment__pic">
              <ChainPlate variant={moment} />
            </div>
            <div className="lp-led">
              <RefusalLedger refusal={shown} triedId={triedId} answerId={answerId} />
              <div className="lp-moment__foot">
                <button type="button" className="hf-px" onClick={close} ref={resume}>
                  Resume
                </button>
                <a className="hf-link hf-link--emphasis" href="#refused" onClick={close}>
                  All six refusals
                </a>
              </div>
            </div>
          </div>
        )}
      </dialog>
    </header>
  );
}
