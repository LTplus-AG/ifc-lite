/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The title block's scale bar must mean what it says (#2731).
 *
 * `renderTitleBlock` takes the sheet's scale two ways and they are RECIPROCAL:
 * `effectiveScaleFactor` is millimetres per metre (10 at 1:100), `scale.factor`
 * is the N of 1:N (100 at 1:100). The renderer divided by whichever it was
 * handed, and `useDrawingExport` hands it the former on every export — so every
 * exported bar was labelled wrong at every scale.
 *
 * Every assertion drives `renderTitleBlock`, the entry the exporter calls, and
 * passes `effectiveScaleFactor`, because omitting it exercises a fallback
 * branch the real exporter never takes. Driving the right entry point is not
 * enough; it has to be driven with the arguments the caller actually supplies.
 */

import { describe, it, expect } from 'vitest';
import { renderTitleBlock, type FrameInnerBounds } from './title-block-renderer.js';
import { DEFAULT_SCALE_BAR, type ScaleBarConfig } from './scale-bar-types.js';
import type { TitleBlockConfig } from './title-block-types.js';
import type { DrawingScale } from '../styles.js';

const FRAME: FrameInnerBounds = { x: 0, y: 0, width: 420, height: 297 };
const SCALE: DrawingScale = { name: '1:100', factor: 100, useCase: 'test' };
const TITLE_BLOCK: TitleBlockConfig = {
  layout: 'standard', position: 'bottom-right', widthMm: 180, heightMm: 60,
  borderWeight: 0.5, gridWeight: 0.25, fields: [], logo: null,
  showRevisionHistory: false, maxRevisionEntries: 0,
};

function barSvg(
  overrides: Partial<ScaleBarConfig> = {},
  block: TitleBlockConfig = TITLE_BLOCK,
  mmPerMetre: number | undefined = 1000 / SCALE.factor,
): string {
  const svg = renderTitleBlock(block, FRAME, [], {
    scaleBar: { ...DEFAULT_SCALE_BAR, ...overrides },
    scale: SCALE,
    effectiveScaleFactor: mmPerMetre,
  }).svgElements;
  const start = svg.indexOf('<g id="title-block-scale-bar">');
  return start < 0 ? '' : svg.slice(start, svg.indexOf('</g>', start));
}

/** Segment widths, excluding `stroke-width` which contains "width=" as a substring. */
const widths = (svg: string) =>
  [...svg.matchAll(/(?<!stroke-)width="([0-9.]+)"/g)].map((m) => Number(m[1]));

/** The end label's distance in metres, parsed from what was actually emitted. */
function labelledMetres(svg: string): number {
  const all = [...svg.matchAll(/>([0-9.]+)(cm|m)<\/text>/g)];
  const m = all[all.length - 1];
  if (!m) throw new Error(`no end label in: ${svg.slice(0, 200)}`);
  return m[2] === 'cm' ? Number(m[1]) / 100 : Number(m[1]);
}

/**
 * THE property: what the bar draws on paper equals what it says it spans.
 * Asserting the label alone would let the bar be any size; asserting the width
 * alone would let the label say anything.
 */
function expectBarHonest(svg: string, mmPerMetre: number, what: string) {
  const drawn = widths(svg).reduce((a, b) => a + b, 0);
  // Tolerance scales with the segment count, because each `width=` is
  // `toFixed(2)` and N of them carry up to N * 0.005 of rounding. A flat 5e-5
  // passed only because every fixture happened to divide evenly: three
  // segments of a 50 mm bar emit 16.67 each and sum to 50.01, which is 200x
  // that tolerance and would have redded for a reason unrelated to the claim.
  const segments = widths(svg).length;
  expect(drawn, `${what}: drawn mm`).toBeCloseTo(labelledMetres(svg) * mmPerMetre, 0);
  expect(Math.abs(drawn - labelledMetres(svg) * mmPerMetre), `${what}: within rounding`)
    .toBeLessThanOrEqual(segments * 0.005 + 1e-9);
}
describe('title block scale bar means what it says (#2731)', () => {
  it('the drawn length matches the labelled distance at every scale', () => {
    // THE measurement property. `effectiveScaleFactor` and `scale.factor` are
    // reciprocal and the renderer used to divide by whichever it got, so a 5 m
    // bar read 0.5 m at 1:100 and 0.1 m at 1:500 where 25 m is right.
    for (const [factorN, mmPerMetre] of [[50, 20], [100, 10], [200, 5], [500, 2]] as const) {
      const wide: TitleBlockConfig = { ...TITLE_BLOCK, widthMm: 600 };
      const svg = barSvg({ totalLengthM: 2, primaryDivisions: 4 }, wide, mmPerMetre);

      expectBarHonest(svg, mmPerMetre, `1:${factorN}`);
      // And it really is the 2 m asked for, not some other honest pairing.
      expect(labelledMetres(svg), `labelled m at 1:${factorN}`).toBe(2);
      // The literal string, because `labelledMetres` parses whichever unit was
      // emitted and so reads "200cm" as honest. Only this sees the renderer
      // drifting from the shared formatter.
      expect(svg, `label text at 1:${factorN}`).toContain('>2m</text>');
    }
  });

  it('the scale.factor fallback labels correctly too', () => {
    // `effectiveScaleFactor` is optional and `renderTitleBlock` is published
    // API, so a caller omitting it takes the OTHER half of the reciprocal fix.
    const wide: TitleBlockConfig = { ...TITLE_BLOCK, widthMm: 600 };
    const svg = barSvg({ totalLengthM: 2, primaryDivisions: 4 }, wide, undefined);
    expectBarHonest(svg, 1000 / SCALE.factor, 'scale.factor fallback');
    expect(labelledMetres(svg)).toBe(2);
  });

  it('a bar too big for its block shrinks to a ROUND distance it can honestly span', () => {
    // The earlier version of this fix clamped to the cell width and folded the
    // clamp into the label — but the label prints to 0 dp, so a 60 mm block
    // capping a 5 m bar at 18 mm (1.8 m) still printed "2m". Rounding undid the
    // fold. Choosing a round distance FIRST makes the label exact instead.
    const mmPerMetre = 1000 / SCALE.factor;
    // 180 and 600 would be the same case: min(w * 0.3, 50) caps both at 50.
    for (const widthMm of [60, 120, 180]) {
      const svg = barSvg({ totalLengthM: 5, primaryDivisions: 5 }, { ...TITLE_BLOCK, widthMm });
      expectBarHonest(svg, mmPerMetre, `${widthMm}mm block`);
      // It fits the cell, and never claims more than was asked for.
      const drawn = widths(svg).reduce((a, b) => a + b, 0);
      expect(drawn, `${widthMm}mm block: fits`).toBeLessThanOrEqual(Math.min(widthMm * 0.3, 50) + 1e-6);
      expect(labelledMetres(svg), `${widthMm}mm block: not inflated`).toBeLessThanOrEqual(5);
    }
    // Control: a roomy block still shows the full 5 m, so the above is not
    // passing by shrinking everything to nothing.
    expect(labelledMetres(barSvg({ totalLengthM: 5, primaryDivisions: 5 }))).toBe(5);
  });

  it('a degenerate division count degrades rather than printing NaN', () => {
    for (const primaryDivisions of [0, -3, 2.5, 100000, Number.NaN]) {
      const svg = barSvg({ primaryDivisions });
      // The segments must fit the bar they divide. `2.5` drew THREE segments of
      // width L/2.5 — the loop runs while `i < 2.5` — overflowing by 20% and
      // spilling past the cell. `100000` emitted an 11.5 MB group.
      //
      // Deliberately NOT asserting the absence of "NaN" or a negative label
      // position here: an earlier version did, with comments claiming the
      // unguarded code produced those. Run against the parent commit it does
      // not — 0 and -3 simply emit no rects and label normally. Those
      // assertions could not fail, and the comments justifying them were
      // false. Width is the only thing that discriminates.
      expectBarHonest(svg, 1000 / SCALE.factor, `divisions=${primaryDivisions}`);
      const drawn = widths(svg).reduce((a, b) => a + b, 0);
      expect(drawn, `total segment width for divisions=${primaryDivisions}`)
        .toBeLessThanOrEqual(Math.min(TITLE_BLOCK.widthMm * 0.3, 50) + 1e-6);
      expect(svg.match(/<rect/g)?.length ?? 0, `rect count for ${primaryDivisions}`)
        .toBeLessThanOrEqual(20);
    }
  });

  it('a degenerate length or an unusable block draws nothing, not negative-width rects', () => {
    for (const totalLengthM of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(barSvg({ totalLengthM }), `totalLengthM=${totalLengthM}`).toBe('');
    }
    for (const bad of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(barSvg({}, TITLE_BLOCK, bad), `scale=${bad}`).toBe('');
    }

    // BOTH operands negative. This is the case a single-negative fixture
    // cannot reach: -5 metres at -10 mm/m multiplies to a perfectly positive
    // 50 mm, so it passes a guard that only checks the product, and the labels
    // then print NEGATIVE distances on a bar that draws normally. Worse than
    // the malformed rect the guard exists to stop, because nothing about the
    // output looks wrong.
    //
    // What this pins is the BEHAVIOUR — no bar, rather than one that draws
    // normally and labels "-500cm". Several checks in the source can each
    // produce that outcome, and which of them is load-bearing has changed
    // three times in this file's short history, so naming one here would be a
    // claim with a shorter shelf life than the test.
    for (const [totalLengthM, mmPerMetre] of [[-5, -10], [-0.5, -20], [-1, -1000]] as const) {
      expect(
        barSvg({ totalLengthM }, TITLE_BLOCK, mmPerMetre),
        `both negative: ${totalLengthM}m at ${mmPerMetre}mm/m`,
      ).toBe('');
    }
    expect(barSvg({}, { ...TITLE_BLOCK, widthMm: 0 })).toBe('');
    // Control: a sane config DOES draw one, so the above is not passing
    // because the fixture never produces a bar.
    expect(barSvg()).toContain('<rect');
  });

  it('a degenerate heightMm does not reach the emitted attributes', () => {
    // The guard covered the two operands of the LENGTH and stopped there, so
    // `heightMm` still went out raw: NaN printed `height="NaN"` on every rect
    // and `y="NaN"` on both labels, and -5 printed `height="-5.00"`. The same
    // "invalid SVG dressed as a drawing" the length guard exists to prevent,
    // one line below it.
    for (const heightMm of [Number.NaN, -5, 0, Number.POSITIVE_INFINITY, 999]) {
      const svg = barSvg({ heightMm });
      expect(svg, `heightMm=${heightMm}`).not.toContain('NaN');
      expect(svg, `heightMm=${heightMm}`).not.toContain('Infinity');
      expect(svg, `heightMm=${heightMm}`).not.toMatch(/height="-/);
      for (const h of [...svg.matchAll(/height="([0-9.]+)"/g)].map((m) => Number(m[1]))) {
        expect(h, `heightMm=${heightMm}: bar height`).toBeGreaterThan(0);
        expect(h, `heightMm=${heightMm}: capped to the cell`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('still draws a bar at the scales where the ladder nearly runs out', () => {
    // The snap's "nothing fits" branch had no test, which is how a regression
    // shipped in the first version of this fix: `maxBarWidth` caps at 50 mm, so
    // at 1:1 (1000 mm per metre) a 0.1 m bar needs 100 mm. With the ladder
    // stopping at 0.1, BOTH 1:1 and 1:2 on the shipped compact preset produced
    // no scale bar at all — a silent regression on two listed scales.
    const compact: TitleBlockConfig = { ...TITLE_BLOCK, widthMm: 120 };
    for (const [label, mmPerMetre, block] of [
      ['1:1 compact', 1000, compact],
      ['1:1 standard', 1000, TITLE_BLOCK],
      ['1:2 compact', 500, compact],
      ['1:5 compact', 200, compact],
    ] as const) {
      const svg = barSvg({ totalLengthM: 0.1 }, block, mmPerMetre);
      expect(svg, `${label}: must still draw a bar`).not.toBe('');
      expectBarHonest(svg, mmPerMetre, label);
    }
  });

  it('does not shrink a bar that already fits and already labels exactly', () => {
    // Snapping unconditionally halved bars that were fine: 4 m at 1:100 is
    // 40 mm in a 50 mm cell and prints "4m" exactly, and the ladder's nearest
    // value below is 2 m. `totalLengthM` is a public config field, so an
    // off-ladder-but-exact request is a caller's legitimate choice.
    // Each pair is a length that FITS its scale's 50 mm cell: 4 m at 10 mm/m is
    // 40 mm, 40 m at 1 mm/m is 40 mm. A length that does not fit is supposed to
    // snap, so using one here would test the opposite of the claim.
    for (const [requested, mmPerMetre] of [[3, 10], [4, 10], [30, 1], [40, 1]] as const) {
      const svg = barSvg({ totalLengthM: requested }, { ...TITLE_BLOCK, widthMm: 600 }, mmPerMetre);
      expect(labelledMetres(svg), `${requested}m at ${mmPerMetre}mm/m kept`).toBe(requested);
      expectBarHonest(svg, mmPerMetre, `${requested}m`);
    }
    const mmPerMetre = 1000 / SCALE.factor;
    // Control: one that does NOT label exactly still snaps down rather than
    // rounding its label, which is the defect this whole change is about.
    const svg = barSvg({ totalLengthM: 3.6 }, { ...TITLE_BLOCK, widthMm: 600 }, mmPerMetre);
    expect(labelledMetres(svg), '3.6m snaps rather than printing "4m"').toBe(2);
  });

  it('never draws a bar whose segments round away to nothing', () => {
    // Removing the clamp-to-cell removed the only thing that kept the drawn bar
    // visible. Segment widths go out through `toFixed(2)`, so anything under
    // 0.005 mm prints `width="0.00"` — a confident label with no bar under it,
    // which is the same dishonesty the length guard exists to stop.
    //
    // Reachable at 1:1 on a large model: the transform gives well under 1 mm
    // per metre there, so a 5 cm bar is 0.02 mm wide and all five of its
    // segments print zero. Measured on the parent of this fix.
    for (const mmPerMetre of [0.42, 0.1, 0.02, 0.001]) {
      const svg = barSvg({ totalLengthM: 0.05 }, TITLE_BLOCK, mmPerMetre);
      if (svg === '') continue; // declining to draw is the honest outcome
      expect(svg, `${mmPerMetre}mm/m: no zero-width segments`).not.toMatch(/(?<!stroke-)width="0\.00"/);
      for (const w of widths(svg)) {
        expect(w, `${mmPerMetre}mm/m: segment width`).toBeGreaterThan(0);
      }
      expectBarHonest(svg, mmPerMetre, `${mmPerMetre}mm/m`);
    }
    // Control: at a sane scale the same config DOES draw, so the loop above is
    // not passing by skipping every case.
    expect(barSvg({ totalLengthM: 0.05 }, TITLE_BLOCK, 200)).toContain('<rect');
  });
});
