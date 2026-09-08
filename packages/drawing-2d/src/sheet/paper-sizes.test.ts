/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { PAPER_SIZE_REGISTRY } from './paper-sizes.js';
import { PAPER_SIZES } from '../styles.js';

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
 * prints to the wrong size, and nothing in the pipeline notices.
 *
 * The registry is not the only statement of what "A1" means. `PAPER_SIZES` in
 * `../styles.ts` is a second A-series table, consumed by the SVG exporter, and
 * it pins no dimensions of its own either. The two agree today; nothing made
 * them agree, so the last test here checks it rather than asserting it in
 * prose.
 *
 * So the assertions below DERIVE rather than restate:
 *   - the ANSI and ARCH sheets are defined in whole inches, so each is
 *     checked as `inches * 25.4` -- writing 215.9 next to 215.9 would prove
 *     nothing, while 8.5 x 11 in is the actual definition;
 *   - the ISO sheets are defined in millimetres by ISO 216, so those are
 *     stated exactly, and then cross-checked against the halving rule, which
 *     no transcription error survives. (A 1:sqrt(2) ratio check was tried and
 *     removed: at toBeCloseTo(SQRT2, 2) a 2 mm error in A0's short edge still
 *     passes it and 3 mm is the first that fails, so every mutation that
 *     reddened it reddened a sharper test first.)
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
// `portrait` states whether the registry is EXPECTED to carry an
// `<id>_PORTRAIT` entry. Only the three US office sizes do; the ANSI and ARCH
// sheets carry a single bare key with no orientation suffix. (Not a size
// distinction -- ARCH_A at 228.6 x 304.8 mm is smaller than LEGAL, which has
// one. It is which series the registry models in both orientations.) It has to be stated rather than inferred,
// because the test previously guarded the portrait checks with `if (portrait)`
// and a guard cannot tell "not expected" from "expected and missing":
// deleting LETTER_PORTRAIT from the registry outright left all 448 tests green.
// Measured, not assumed. Reported by CodeRabbit on #3162.
const INCH_DEFINED: ReadonlyArray<{
  id: string;
  shortIn: number;
  longIn: number;
  portrait: boolean;
}> = [
  // ANSI / US office sizes.
  { id: 'LETTER', shortIn: 8.5, longIn: 11, portrait: true },
  { id: 'LEGAL', shortIn: 8.5, longIn: 14, portrait: true },
  { id: 'TABLOID', shortIn: 11, longIn: 17, portrait: true }, // ANSI B
  { id: 'ANSI_C', shortIn: 17, longIn: 22, portrait: false },
  { id: 'ANSI_D', shortIn: 22, longIn: 34, portrait: false },
  { id: 'ANSI_E', shortIn: 34, longIn: 44, portrait: false },
  // Architectural series.
  { id: 'ARCH_A', shortIn: 9, longIn: 12, portrait: false },
  { id: 'ARCH_B', shortIn: 12, longIn: 18, portrait: false },
  { id: 'ARCH_C', shortIn: 18, longIn: 24, portrait: false },
  { id: 'ARCH_D', shortIn: 24, longIn: 36, portrait: false },
  { id: 'ARCH_E', shortIn: 36, longIn: 48, portrait: false },
  { id: 'ARCH_E1', shortIn: 30, longIn: 42, portrait: false },
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
    // to a whole millimetre by the standard). A single mistyped digit breaks
    // this chain even when the number still looks plausible on its own.
    //
    // Walked over the REGISTRY, not over ISO_216_MM. Reading the oracle table
    // and comparing its rows to each other would assert the test file against
    // itself: no edit to paper-sizes.ts could fail it, so it would report a
    // guarantee about production that it never touches. The portrait entries
    // carry the standard's own orientation (width = short edge), so the chain
    // reads directly off them.
    for (let i = 1; i < ISO_216_MM.length; i++) {
      const biggerKey = `${ISO_216_MM[i - 1].series}_PORTRAIT`;
      const smallerKey = `${ISO_216_MM[i].series}_PORTRAIT`;
      const bigger = PAPER_SIZE_REGISTRY[biggerKey];
      const smaller = PAPER_SIZE_REGISTRY[smallerKey];
      expect(bigger, `${biggerKey} missing from the registry`).toBeDefined();
      expect(smaller, `${smallerKey} missing from the registry`).toBeDefined();
      expect(smaller.heightMm, `${smallerKey} long edge`).toBe(bigger.widthMm);
      expect(smaller.widthMm, `${smallerKey} short edge`).toBe(
        Math.floor(bigger.heightMm / 2),
      );
    }
  });

});

describe('inch-defined sheets (ANSI and ARCH)', () => {
  for (const { id, shortIn, longIn, portrait: expectPortrait } of INCH_DEFINED) {
    it(`${id} is ${shortIn}" x ${longIn}"`, () => {
      // Landscape-only ids (ANSI_C..E, ARCH_*) carry no orientation suffix.
      const landscape = PAPER_SIZE_REGISTRY[`${id}_LANDSCAPE`] ?? PAPER_SIZE_REGISTRY[id];
      expect(landscape, `${id} missing from the registry`).toBeDefined();

      // 25.4 mm to the inch is exact by definition (1959 agreement), but the
      // product is not exactly representable in binary floating point, so
      // compare to well below the precision anyone can print at.
      expect(landscape.widthMm).toBeCloseTo(longIn * MM_PER_INCH, 6);
      expect(landscape.heightMm).toBeCloseTo(shortIn * MM_PER_INCH, 6);

      // Both directions: an expected portrait entry must EXIST (a bare
      // `if (portrait)` let its deletion pass), and an unexpected one must not
      // appear. The second direction is NOT about `view-pdf-scale`: that file
      // reads the registry once (view-pdf-scale.ts:162) and skips every
      // non-ISO entry on the next line, so an added ANSI or ARCH portrait is
      // unreachable from it -- measured by adding all nine and diffing
      // `describePage` over 130 page sizes, output byte-identical. Nor does it
      // reach the sheet dropdown, which gates on the hardcoded
      // `PAPER_SIZE_GROUPS` rather than on the registry. What it does change is
      // the public surface: `getPaperSizesByCategory` (paper-sizes.ts:273) is
      // exported from the package root and the SDK returns both it and the raw
      // registry (sdk/src/namespaces/drawing.ts:187-192). An unexpected key is
      // a silent addition to what the registry claims exists.
      const portrait = PAPER_SIZE_REGISTRY[`${id}_PORTRAIT`];
      if (expectPortrait) {
        expect(portrait, `${id}_PORTRAIT must exist in the registry`).toBeDefined();
        expect(portrait.widthMm).toBeCloseTo(shortIn * MM_PER_INCH, 6);
        expect(portrait.heightMm).toBeCloseTo(longIn * MM_PER_INCH, 6);
      } else {
        expect(portrait, `${id}_PORTRAIT is not expected to exist`).toBeUndefined();
      }
    });
  }
});

describe('registry shape', () => {
  it('every entry is self-consistent', () => {
    // `id` is NOT a lookup key: every production read of the registry indexes by
    // the registry KEY (SheetSetupPanel.tsx:111 Object.entries, :217-218
    // `id in PAPER_SIZE_REGISTRY`, sheetSlice.ts:111 and :207), and the only
    // read of the `id` FIELD is the tie-break `paper.id < best.id` at
    // view-pdf-scale.ts:176. So a mismatch cannot "resolve to nothing" — it
    // would mis-order which sheet name a page reports. Keeping the two in step
    // is still worth asserting, because the field exists to name the entry and
    // a disagreement makes every downstream report ambiguous.
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
    // Nothing rotates a drawing from this field. Its only production consumer is
    // view-pdf-scale.ts:174, `(p.orientation === 'landscape') === pageIsLandscape`,
    // which biases WHICH registry entry a page is reported as; sheet transforms
    // and the PDF path use widthMm/heightMm directly. A landscape entry taller
    // than it is wide therefore mislabels a sheet rather than rotating it —
    // still worth pinning, because the label is what a user reads back.
    for (const [key, def] of Object.entries(PAPER_SIZE_REGISTRY)) {
      if (def.orientation === 'landscape') {
        expect(def.widthMm, `${key} is landscape but taller than wide`).toBeGreaterThanOrEqual(def.heightMm);
      } else {
        expect(def.heightMm, `${key} is portrait but wider than tall`).toBeGreaterThanOrEqual(def.widthMm);
      }
    }
  });
});

describe('the second A-series table in styles.ts', () => {
  /*
   * `PAPER_SIZES` (../styles.ts) is an independent A-series table feeding the
   * SVG exporter, written in `width`/`height` rather than `widthMm`/`heightMm`.
   * Nothing derives one table from the other and nothing compares them, so
   * correcting a sheet in one place leaves the other wrong and every test in
   * both files stays green. That is the failure this test exists to make loud.
   *
   * Verified it can fail: setting styles.ts A2 width to 421 reds this test and
   * only this one -- the other 448 tests in this package stay green, which is
   * the point. Not measured outside `packages/drawing-2d`.
   */
  it('agrees with the sheet registry on every size it names', () => {
    for (const [stylesKey, size] of Object.entries(PAPER_SIZES)) {
      const registryKey = stylesKey.includes('_LANDSCAPE')
        ? stylesKey
        : `${stylesKey}_PORTRAIT`;
      const entry = PAPER_SIZE_REGISTRY[registryKey];
      expect(entry, `${stylesKey} has no registry counterpart (${registryKey})`).toBeDefined();
      expect(size.width, `${stylesKey} width vs ${registryKey}`).toBe(entry.widthMm);
      expect(size.height, `${stylesKey} height vs ${registryKey}`).toBe(entry.heightMm);
    }
  });
});
