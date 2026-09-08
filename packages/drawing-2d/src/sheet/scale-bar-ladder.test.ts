/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared nice-length ladder and the label-exactness predicate.
 *
 * These moved here so the sheet's "what length should this bar default to"
 * (`calculateOptimalScaleBarLength`, used by `sheetSlice`) and the title
 * block's "largest one that fits this cell" cannot disagree about what "nice"
 * means. `calculateOptimalScaleBarLength` had NO test before that move, and
 * the move changes its output — so it gets one here.
 */

import { describe, it, expect } from 'vitest';
import {
  NICE_BAR_LENGTHS_M,
  barLabelIsExact,
  calculateOptimalScaleBarLength,
  formatBarLabel,
} from './scale-bar-types.js';

// The renderer's own formatter, imported rather than reimplemented. A private
// copy here would agree with itself no matter how the renderer changed, which
// is an oracle that cannot disagree with what it checks.
const format = formatBarLabel;

describe('the shared bar-length ladder', () => {
  it('every entry survives its own label formatting', () => {
    // This is the property the snap depends on to promise an exact label, so a
    // new entry has to keep it. 0.15 would print "15cm" correctly; 0.125 would
    // print "13cm" and lie.
    for (const m of NICE_BAR_LENGTHS_M) {
      expect(barLabelIsExact(m), `barLabelIsExact(${m})`).toBe(true);
      const printed = format(m);
      const parsed = printed.endsWith('cm')
        ? Number(printed.slice(0, -2)) / 100
        : Number(printed.slice(0, -1));
      expect(parsed, `${m} prints as ${printed}`).toBeCloseTo(m, 9);
    }
  });

  it('is ascending and reaches low enough for 1:1', () => {
    for (let i = 1; i < NICE_BAR_LENGTHS_M.length; i++) {
      expect(NICE_BAR_LENGTHS_M[i]).toBeGreaterThan(NICE_BAR_LENGTHS_M[i - 1]);
    }
    // The binding number is 36, not 50: `maxBarWidth` is
    // `min(width * 0.3, 50)` and the shipped `compact` preset is 120 mm wide.
    // Asserting against 50 passes with a 0.05 floor while 1:1 on that preset
    // draws no bar at all, which is the regression this is here to stop.
    expect(NICE_BAR_LENGTHS_M[0] * 1000).toBeLessThanOrEqual(36);
  });
});

describe('formatBarLabel', () => {
  it('prints the literal strings the renderer is expected to emit', () => {
    // Literals, not a round trip. The round-trip check above parses whatever
    // unit was emitted, so it reads "500cm" for a 5 m bar as perfectly honest —
    // it cannot see the cm/m threshold moving. These can.
    expect(formatBarLabel(0.02)).toBe('2cm');
    expect(formatBarLabel(0.5)).toBe('50cm');
    expect(formatBarLabel(1)).toBe('1m');
    expect(formatBarLabel(5)).toBe('5m');
    expect(formatBarLabel(1000)).toBe('1000m');
  });
});

describe('barLabelIsExact', () => {
  it('rejects lengths that would print a rounded lie', () => {
    // Tolerant enough for the ladder's own float artefacts, strict enough to
    // reject a value half a millimetre off. The old form used
    // `Math.round(m * 1000) / 10`, which tolerated ±0.5 mm and let 0.0201
    // through to print "2cm" over a bar 0.1 mm too long.
    expect(barLabelIsExact(0.02)).toBe(true);
    expect(barLabelIsExact(0.0201)).toBe(false);
    expect(barLabelIsExact(2.5)).toBe(false);
    expect(barLabelIsExact(3.6)).toBe(false);
  });

  it('rejects a length too small to print as a whole centimetre', () => {
    // Anything under 0.005 m rounds to zero centimetres, which IS an integer,
    // so the old predicate called it exact and the renderer drew a 0.4 mm bar
    // labelled "0cm".
    for (const m of [0.0004, 0.001, 0.004, 0.00499]) {
      expect(barLabelIsExact(m), `${m}`).toBe(false);
    }
    expect(barLabelIsExact(0.01)).toBe(true);

    // The `>= 1` centimetre floor exists for THIS, and only this: a length so
    // small that it IS within the epsilon of zero centimetres. Everything
    // between here and 1 cm is already rejected by the epsilon itself, since
    // 0.4 cm is nowhere near an integer. Without the floor this draws a
    // zero-length bar labelled "0cm".
    // Only 1e-12 actually reaches the floor: 1e-10 m is 1e-8 cm and 1e-9 m is
    // 1e-7 cm, both of which exceed the 1e-9 epsilon and are rejected before
    // the floor is consulted. Keeping all three, with this note, so a later
    // trim to "one representative" does not keep 1e-9 and silently drop the
    // only floor coverage in the suite.
    for (const m of [1e-12, 1e-10, 1e-9]) {
      expect(barLabelIsExact(m), `${m}`).toBe(false);
    }
  });

  it('rejects non-positive and non-finite', () => {
    // -5 formats to "-500cm" perfectly happily, which is why the predicate has
    // to say so rather than leaving it to a caller's sign check.
    for (const m of [0, -5, -0.02, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(barLabelIsExact(m), `${m}`).toBe(false);
    }
  });
});

describe('calculateOptimalScaleBarLength', () => {
  it('returns a usable length across the shipped scales', () => {
    // It had no test, and sharing the ladder changed its output: adding 0.02
    // and 0.05 turned three previously-0 results into real lengths, because
    // the old list bottomed out at 0.1 and fell through to
    // `Math.round(modelLength)`. A 0 default means the sheet asks for a bar of
    // no length, which the renderer then declines to draw.
    for (const scaleFactor of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
      for (const maxLengthMm of [36, 50, 80, 200]) {
        const m = calculateOptimalScaleBarLength(scaleFactor, maxLengthMm);
        expect(m, `1:${scaleFactor} in ${maxLengthMm}mm`).toBeGreaterThan(0);
        expect(barLabelIsExact(m), `1:${scaleFactor} in ${maxLengthMm}mm -> ${m}`).toBe(true);
      }
    }
  });

  it('can still return a non-ladder value from its rounding fallback', () => {
    // The 40 cells above all match a ladder entry, so the `Math.round` fallback
    // never runs there — asserting "never 0" over them would have been a claim
    // about a branch the test does not reach. It IS reachable with a small
    // enough paper budget, and it returns 0 there.
    expect(calculateOptimalScaleBarLength(1, 16)).toBe(0);
    expect(barLabelIsExact(calculateOptimalScaleBarLength(1, 16))).toBe(false);
    // Which the renderer then declines to draw rather than emitting a bar of
    // no length — the two halves agree about what an unusable length is.
  });
});
