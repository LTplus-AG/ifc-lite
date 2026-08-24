/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { PAPER_SIZE_REGISTRY } from './paper-sizes.js';

/**
 * Pins every sheet in the registry to its published standard.
 *
 * Measured before writing this: A0, A1, A2, A4, the ANSI series and the ARCH
 * series can all be given wrong dimensions and the whole repo stays green.
 * Setting A4 to 216x279 -- US Letter's millimetres, the most realistic wrong
 * answer there is -- left `packages/drawing-2d` at 425/425 and the viewer's
 * sheet and PDF-export tests at 0 failures. Only A3 was pinned, incidentally,
 * by `view-pdf-scale.test.ts:138` feeding the literal 420x297.
 *
 * That matters because these numbers are not internal conventions. A sheet
 * that is a few millimetres wrong scales every drawing placed on it and
 * prints to the wrong size, and nothing in the pipeline can notice: the
 * registry is the only statement of what "A1" means.
 *
 * So the assertions below DERIVE rather than restate:
 *   - the ANSI and ARCH sheets are defined in whole inches, so each is
 *     checked as `inches * 25.4` -- writing 215.9 next to 215.9 would prove
 *     nothing, while 8.5 x 11 in is the actual definition;
 *   - the ISO sheets are defined in millimetres by ISO 216, so those are
 *     stated exactly, and then cross-checked against the standard's two
 *     structural rules (halving, and a 1:sqrt(2) ratio) which no transcription
 *     error survives.
 *
 * Never regenerate these numbers from what the registry currently holds.
 */

/** ISO 216 defines the A series in whole millimetres. */
const ISO_216_MM: ReadonlyArray<{ series: string; shortMm: number; longMm: number }> = [
  { series: 'A0', shortMm: 841, longMm: 1189 },
  { series: 'A1', shortMm: 594, longMm: 841 },
  { series: 'A2', shortMm: 420, longMm: 594 },
  { series: 'A3', shortMm: 297, longMm: 420 },
  { series: 'A4', shortMm: 210, longMm: 297 },
];

/** ANSI and ARCH sheets are defined in inches. */
const MM_PER_INCH = 25.4;
const INCH_DEFINED: ReadonlyArray<{ id: string; shortIn: number; longIn: number }> = [
  // ANSI / US office sizes.
  { id: 'LETTER', shortIn: 8.5, longIn: 11 },
  { id: 'LEGAL', shortIn: 8.5, longIn: 14 },
  { id: 'TABLOID', shortIn: 11, longIn: 17 }, // ANSI B
  { id: 'ANSI_C', shortIn: 17, longIn: 22 },
  { id: 'ANSI_D', shortIn: 22, longIn: 34 },
  { id: 'ANSI_E', shortIn: 34, longIn: 44 },
  // Architectural series.
  { id: 'ARCH_A', shortIn: 9, longIn: 12 },
  { id: 'ARCH_B', shortIn: 12, longIn: 18 },
  { id: 'ARCH_C', shortIn: 18, longIn: 24 },
  { id: 'ARCH_D', shortIn: 24, longIn: 36 },
  { id: 'ARCH_E', shortIn: 36, longIn: 48 },
  { id: 'ARCH_E1', shortIn: 30, longIn: 42 },
];

describe('ISO 216 A series', () => {
  for (const { series, shortMm, longMm } of ISO_216_MM) {
    it(`${series} is ${shortMm} x ${longMm} mm in both orientations`, () => {
      const landscape = PAPER_SIZE_REGISTRY[`${series}_LANDSCAPE`];
      const portrait = PAPER_SIZE_REGISTRY[`${series}_PORTRAIT`];
      expect(landscape, `${series}_LANDSCAPE missing from the registry`).toBeDefined();
      expect(portrait, `${series}_PORTRAIT missing from the registry`).toBeDefined();

      // Landscape puts the long edge across. A swapped pair is the easiest
      // mistake to make here and the hardest to see on screen.
      expect(landscape.widthMm).toBe(longMm);
      expect(landscape.heightMm).toBe(shortMm);
      expect(portrait.widthMm).toBe(shortMm);
      expect(portrait.heightMm).toBe(longMm);
    });
  }

  it('each size halves the one above it, as ISO 216 defines', () => {
    // A(n+1) is A(n) cut across its long edge: the short edge becomes the new
    // long edge, and the new short edge is half the old long one (rounded down
    // to a whole millimetre by the standard). A single mistyped digit anywhere
    // in the table breaks this chain even when the number still looks
    // plausible on its own.
    for (let i = 1; i < ISO_216_MM.length; i++) {
      const bigger = ISO_216_MM[i - 1];
      const smaller = ISO_216_MM[i];
      expect(smaller.longMm, `${smaller.series} long edge`).toBe(bigger.shortMm);
      expect(smaller.shortMm, `${smaller.series} short edge`).toBe(Math.floor(bigger.longMm / 2));
    }
  });

  it('holds the 1:sqrt(2) ratio that makes halving work', () => {
    // The aspect ratio is what the whole series is built on. Rounding to
    // whole millimetres moves it slightly, which is why this is a tolerance
    // rather than an equality — but not by more than half a millimetre's
    // worth at the smallest size.
    for (const { series, shortMm, longMm } of ISO_216_MM) {
      const registry = PAPER_SIZE_REGISTRY[`${series}_PORTRAIT`];
      expect(registry.heightMm / registry.widthMm, `${series} ratio`).toBeCloseTo(Math.SQRT2, 2);
      expect(longMm / shortMm, `${series} reference ratio`).toBeCloseTo(Math.SQRT2, 2);
    }
  });
});

describe('inch-defined sheets (ANSI and ARCH)', () => {
  for (const { id, shortIn, longIn } of INCH_DEFINED) {
    it(`${id} is ${shortIn}" x ${longIn}"`, () => {
      // Landscape-only ids (ANSI_C..E, ARCH_*) carry no orientation suffix.
      const landscape = PAPER_SIZE_REGISTRY[`${id}_LANDSCAPE`] ?? PAPER_SIZE_REGISTRY[id];
      expect(landscape, `${id} missing from the registry`).toBeDefined();

      // 25.4 mm to the inch is exact by definition (1959 agreement), but the
      // product is not exactly representable in binary floating point, so
      // compare to well below the precision anyone can print at.
      expect(landscape.widthMm).toBeCloseTo(longIn * MM_PER_INCH, 6);
      expect(landscape.heightMm).toBeCloseTo(shortIn * MM_PER_INCH, 6);

      const portrait = PAPER_SIZE_REGISTRY[`${id}_PORTRAIT`];
      if (portrait) {
        expect(portrait.widthMm).toBeCloseTo(shortIn * MM_PER_INCH, 6);
        expect(portrait.heightMm).toBeCloseTo(longIn * MM_PER_INCH, 6);
      }
    });
  }
});

describe('registry shape', () => {
  it('every entry is self-consistent', () => {
    // `id` is used as a lookup key by the sheet UI and the PDF exporter, so an
    // entry whose `id` disagrees with its registry key resolves to nothing at
    // one of the two call sites and silently falls back.
    for (const [key, def] of Object.entries(PAPER_SIZE_REGISTRY)) {
      expect(def.id, `${key} has a mismatched id`).toBe(key);
      expect(def.widthMm, `${key} width`).toBeGreaterThan(0);
      expect(def.heightMm, `${key} height`).toBeGreaterThan(0);
      expect(def.defaultMarginMm, `${key} margin`).toBeGreaterThanOrEqual(0);
      // A margin at or past half the short edge leaves no printable area.
      expect(def.defaultMarginMm * 2, `${key} margin swallows the sheet`).toBeLessThan(
        Math.min(def.widthMm, def.heightMm),
      );
    }
  });

  it('orientation matches the dimensions it describes', () => {
    // A landscape entry taller than it is wide would rotate every drawing
    // placed on it, and nothing downstream re-derives this from the numbers.
    for (const [key, def] of Object.entries(PAPER_SIZE_REGISTRY)) {
      if (def.orientation === 'landscape') {
        expect(def.widthMm, `${key} is landscape but taller than wide`).toBeGreaterThanOrEqual(def.heightMm);
      } else {
        expect(def.heightMm, `${key} is portrait but wider than tall`).toBeGreaterThanOrEqual(def.widthMm);
      }
    }
  });
});
