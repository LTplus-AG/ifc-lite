/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scale record a to-scale sheet carries on the paper itself: a drawn scale
 * bar plus the "1:N" text, laid out in millimetres in a band below the drawing
 * (issue #2042).
 *
 * WHY A SHEET WITHOUT THIS IS DANGEROUS. A to-scale PDF whose only record of
 * its scale is its filename says nothing once it is printed. The whole promise
 * of the export is "measurements taken off the print are correct", and a sheet
 * that carries no scale invites someone to measure it at an assumed one. The
 * printed ratio fixes that for the original; the BAR fixes it for every copy
 * after, because a photocopier that shrinks a sheet to 94% shrinks the bar with
 * it while the text "1:100" keeps claiming a scale the paper no longer has.
 * Those are two different failures, so the sheet carries both.
 *
 * WHAT THIS FILE MUST NEVER DO — the reason it exists as layout maths and not
 * as a sheet template. `sheet-types.ts`'s `calculateDrawingTransform` fits a
 * drawing into a fixed viewport (`fitScale = min(scaleX, scaleY, 1)`), which
 * silently shrinks it. Adding furniture through anything that re-fits would
 * turn an exact sheet into a plausible-looking wrong one, which is the single
 * defect this whole feature exists to prevent. So the band is added by GROWING
 * the page down (and right, only if the stamp is wider than the drawing) and
 * the drawing's `PdfScaleTransform` is passed through untouched — same
 * `worldToMm`, same offsets, same object. Adding a scale bar cannot move a
 * single millimetre of the drawing, by construction rather than by care.
 *
 * The emission is deliberately not here: these are plain rectangles and text
 * runs in page millimetres, so the viewer can write them with jsPDF while the
 * sibling renderers in this folder keep emitting SVG strings.
 */

import {
  formatScaleFactorLabel,
  formatSheetScaleLabel,
  type PdfPage,
  type PdfScaleLayout,
  type PdfScaleTransform,
} from '../pdf-scale.js';

// ═══════════════════════════════════════════════════════════════════════════
// SHAPES
// ═══════════════════════════════════════════════════════════════════════════

/** One rectangle of the bar, in page millimetres from the page's top-left. */
export interface ScaleStampRect {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  /** Painted solid when true, outline only when false. Always stroked. */
  filled: boolean;
}

/** One text run of the stamp, in page millimetres from the page's top-left. */
export interface ScaleStampText {
  text: string;
  xMm: number;
  /** The text BASELINE, which is where PDF text origins sit. */
  yMm: number;
  align: 'left' | 'center';
  /** Nominal text height (em size) in mm, for the writer to convert to points. */
  heightMm: number;
  /**
   * The model distance this label marks, in metres, or `null` for free text
   * such as the ratio. A consumer can multiply it by the transform's
   * `worldToMm` and check that the label really sits there — which is what
   * makes "the bar is drawn to scale" a measurable claim rather than a hope.
   */
  metres: number | null;
}

/** The bar itself, kept as numbers so callers can measure it. */
export interface ScaleStampBar {
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  divisions: number;
  /** Model length of one division, in metres. */
  divisionMetres: number;
  /** Paper length of one division: exactly `divisionMetres * worldToMm`. */
  divisionWidthMm: number;
}

export interface ScaleStamp {
  bar: ScaleStampBar;
  rects: readonly ScaleStampRect[];
  texts: readonly ScaleStampText[];
  /** Extent of the band from its origin, mm. */
  widthMm: number;
  heightMm: number;
  /** The ratio as printed, e.g. "1:100". Never a rounded stand-in. */
  scaleLabel: string;
}

export interface ScaleStampOptions {
  /** Millimetres of paper per metre of world: `PdfScaleTransform.worldToMm`. */
  worldToMm: number;
  /** Paper the band may use before the page has to grow to hold it, mm. */
  availableWidthMm: number;
  /** Top-left corner of the band, in page millimetres. */
  originXMm: number;
  originYMm: number;
}

/** A drawing layout plus the scale band underneath it. */
export interface StampedSheetLayout {
  page: PdfPage;
  /**
   * The drawing's transform, unchanged. The band is added below and to the
   * right of everything the drawing occupies, so no offset is needed and none
   * is applied: this is the same object `computePdfScaleLayout` returned.
   */
  transform: PdfScaleTransform;
  stamp: ScaleStamp;
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYOUT CONSTANTS (millimetres on paper, at any scale)
// ═══════════════════════════════════════════════════════════════════════════

const BAR_TOP_GAP_MM = 4;
const BAR_HEIGHT_MM = 2.5;
const TICK_LABEL_GAP_MM = 1;
const TICK_LABEL_HEIGHT_MM = 2.5;
const RATIO_TEXT_GAP_MM = 1.5;
const RATIO_TEXT_HEIGHT_MM = 3.5;
const BOTTOM_PAD_MM = 2;

/** Height of the whole band. Independent of scale, bar length and page size. */
export const SCALE_STAMP_HEIGHT_MM =
  BAR_TOP_GAP_MM +
  BAR_HEIGHT_MM +
  TICK_LABEL_GAP_MM +
  TICK_LABEL_HEIGHT_MM +
  RATIO_TEXT_GAP_MM +
  RATIO_TEXT_HEIGHT_MM +
  BOTTOM_PAD_MM;

/** Shortest bar worth printing: below this the divisions stop being readable. */
const MIN_BAR_WIDTH_MM = 20;
/** What a bar is aimed at when there is room, mm. */
const TARGET_BAR_WIDTH_MM = 60;

/**
 * Division lengths a surveyor would recognise, in metres. The 1-2-5 sequence
 * is what keeps the labels round ("0 1 2 3 4 m") instead of "0 1.27 2.54"; a
 * bar whose ticks fall on arbitrary numbers is measurable but unreadable.
 */
const DIVISION_STEPS_M = [
  0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
];
/** Division counts, most preferred first. */
const DIVISION_COUNTS = [4, 2];

/**
 * Width of one character as a fraction of the text height. Helvetica averages
 * about 0.5 em, so this OVER-estimates on purpose: the only thing it decides
 * is whether the page has to grow to hold the band, and over-estimating leaves
 * blank paper while under-estimating would run a label off the sheet.
 */
const TEXT_WIDTH_PER_HEIGHT = 0.62;

// ═══════════════════════════════════════════════════════════════════════════
// BUILD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lay out a scale bar and its ratio text with their top-left corner at
 * (`originXMm`, `originYMm`).
 *
 * Throws on a non-finite or non-positive `worldToMm` and on non-finite
 * placement: a stamp is the sheet's statement about its own scale, so emitting
 * one from numbers that do not describe a scale would be worse than emitting
 * none at all.
 */
export function buildScaleStamp(options: ScaleStampOptions): ScaleStamp {
  const { worldToMm, availableWidthMm, originXMm, originYMm } = options;
  if (!Number.isFinite(worldToMm) || worldToMm <= 0) {
    throw new Error(
      `Invalid scale for a scale bar: ${worldToMm} mm per metre. Expected a positive finite number.`,
    );
  }
  if (
    !Number.isFinite(availableWidthMm) ||
    !Number.isFinite(originXMm) ||
    !Number.isFinite(originYMm)
  ) {
    throw new Error('Invalid scale bar placement: origin and available width must be finite.');
  }

  const { divisions, divisionMetres } = chooseBarDivisions(worldToMm, availableWidthMm);
  const divisionWidthMm = divisionMetres * worldToMm;
  const barWidthMm = divisions * divisionWidthMm;
  const barTopMm = originYMm + BAR_TOP_GAP_MM;

  // Alternating filled and hollow divisions: the classic bar, and the one that
  // still reads at a glance after a photocopy has washed out the tick labels.
  const rects: ScaleStampRect[] = [];
  for (let i = 0; i < divisions; i++) {
    rects.push({
      xMm: originXMm + i * divisionWidthMm,
      yMm: barTopMm,
      widthMm: divisionWidthMm,
      heightMm: BAR_HEIGHT_MM,
      filled: i % 2 === 0,
    });
  }

  const tickBaselineMm = barTopMm + BAR_HEIGHT_MM + TICK_LABEL_GAP_MM + TICK_LABEL_HEIGHT_MM;
  const texts: ScaleStampText[] = [];
  for (let i = 0; i <= divisions; i++) {
    const metres = i * divisionMetres;
    // Same rounding rule as the ratio below (2 dp, trailing zeros trimmed):
    // one rule for every number this package prints on a sheet, rather than a
    // second one here that could disagree about, say, 0.30000000000000004.
    const value = formatScaleFactorLabel(metres);
    texts.push({
      // The unit rides on the last label only: repeating "m" under every tick
      // is clutter, and omitting it everywhere leaves the bar unitless.
      text: i === divisions ? `${value} m` : value,
      xMm: originXMm + i * divisionWidthMm,
      yMm: tickBaselineMm,
      align: 'center',
      heightMm: TICK_LABEL_HEIGHT_MM,
      metres,
    });
  }

  // The ratio goes through the shared formatter, so a 1:99.5 sheet prints
  // "1:99.5" and never the materially different "1:100" (#2119). `worldToMm`
  // IS the scale the drawing was laid out at, so deriving the label from it
  // rather than from a separately passed factor removes the whole class of
  // sheet-says-one-thing-drawn-at-another defects.
  //
  // And when 2 decimals cannot hold the factor — "as displayed" delivers
  // 1:87.3456 — the label says "about", because a bare "1:87.35" would be a
  // number an engineer trusts and should not. The bar below it stays exact.
  const scaleLabel = formatSheetScaleLabel(1000 / worldToMm);
  const ratioBaselineMm = tickBaselineMm + RATIO_TEXT_GAP_MM + RATIO_TEXT_HEIGHT_MM;
  texts.push({
    text: `Scale ${scaleLabel}`,
    xMm: originXMm,
    yMm: ratioBaselineMm,
    align: 'left',
    heightMm: RATIO_TEXT_HEIGHT_MM,
    metres: null,
  });

  return {
    bar: {
      xMm: originXMm,
      yMm: barTopMm,
      widthMm: barWidthMm,
      heightMm: BAR_HEIGHT_MM,
      divisions,
      divisionMetres,
      divisionWidthMm,
    },
    rects,
    texts,
    widthMm: stampWidthMm(originXMm, barWidthMm, texts),
    heightMm: SCALE_STAMP_HEIGHT_MM,
    scaleLabel,
  };
}

/**
 * Grow `base` by a scale band under the drawing.
 *
 * The page gains exactly `SCALE_STAMP_HEIGHT_MM` of height, and width only if
 * the band is wider than the drawing. The transform is returned as it came in
 * — see {@link StampedSheetLayout.transform}.
 */
export function addScaleStamp(
  base: PdfScaleLayout,
  options: { marginMm: number },
): StampedSheetLayout {
  const { marginMm } = options;
  if (!Number.isFinite(marginMm) || marginMm < 0) {
    throw new Error(`Invalid sheet margin: ${marginMm}mm. Expected a non-negative finite number.`);
  }
  if (
    !Number.isFinite(base.page.widthMm) || !Number.isFinite(base.page.heightMm) ||
    base.page.widthMm <= 0 || base.page.heightMm <= 0
  ) {
    throw new Error('Cannot add a scale bar to a page that has no usable size.');
  }

  const stamp = buildScaleStamp({
    worldToMm: base.transform.worldToMm,
    availableWidthMm: Math.max(0, base.page.widthMm - marginMm * 2),
    originXMm: marginMm,
    // The drawing's bottom edge: `computePdfScaleLayout` puts it exactly one
    // margin above the page bottom, so the band starts where the ink stops.
    originYMm: base.page.heightMm - marginMm,
  });

  const page: PdfPage = {
    widthMm: Math.max(base.page.widthMm, marginMm * 2 + stamp.widthMm),
    heightMm: base.page.heightMm + stamp.heightMm,
  };
  if (!Number.isFinite(page.widthMm) || !Number.isFinite(page.heightMm)) {
    throw new Error(
      `Adding a scale bar produced a non-finite page (${page.widthMm}x${page.heightMm}mm).`,
    );
  }

  return { page, transform: base.transform, stamp };
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNALS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pick the division count and length whose bar comes closest to
 * `TARGET_BAR_WIDTH_MM` without exceeding the space available.
 *
 * When nothing readable fits — a drawing narrower than the shortest useful bar
 * — the shortest readable bar wins anyway and the caller's page grows to hold
 * it. A bar squeezed to 3 mm would be present, in scale, and useless, which is
 * the one outcome worse than a slightly wider sheet.
 */
function chooseBarDivisions(
  worldToMm: number,
  availableWidthMm: number,
): { divisions: number; divisionMetres: number } {
  let fitting: { divisions: number; divisionMetres: number } | null = null;
  let fittingScore = Infinity;
  let smallest: { divisions: number; divisionMetres: number } | null = null;
  let smallestWidth = Infinity;
  let largest: { divisions: number; divisionMetres: number } | null = null;
  let largestWidth = -Infinity;

  for (const divisions of DIVISION_COUNTS) {
    for (const divisionMetres of DIVISION_STEPS_M) {
      const widthMm = divisions * divisionMetres * worldToMm;
      if (!Number.isFinite(widthMm) || widthMm <= 0) continue;
      const candidate = { divisions, divisionMetres };

      if (widthMm > largestWidth) {
        largest = candidate;
        largestWidth = widthMm;
      }
      if (widthMm >= MIN_BAR_WIDTH_MM && widthMm < smallestWidth) {
        smallest = candidate;
        smallestWidth = widthMm;
      }
      if (widthMm >= MIN_BAR_WIDTH_MM && widthMm <= availableWidthMm) {
        const score = Math.abs(widthMm - TARGET_BAR_WIDTH_MM);
        if (score < fittingScore) {
          fitting = candidate;
          fittingScore = score;
        }
      }
    }
  }

  const chosen = fitting ?? smallest ?? largest;
  if (!chosen) {
    throw new Error(
      `No scale bar length is expressible at ${worldToMm} mm per metre. Choose a less extreme scale.`,
    );
  }
  return chosen;
}

/**
 * How far right of `originXMm` the band reaches — the number that decides
 * whether the page has to grow.
 *
 * Tick labels are deliberately NOT counted. Each is centred on its tick, so the
 * last one overhangs the bar's end by half its width: about 2 mm of a 10 mm
 * margin, on blank paper, and counting it would widen every sheet by that much
 * for nothing. Only the bar and the left-aligned runs can actually reach past
 * the drawing.
 */
function stampWidthMm(
  originXMm: number,
  barWidthMm: number,
  texts: readonly ScaleStampText[],
): number {
  let right = originXMm + barWidthMm;
  for (const text of texts) {
    if (text.align !== 'left') continue;
    const textRight = text.xMm + text.text.length * text.heightMm * TEXT_WIDTH_PER_HEIGHT;
    if (textRight > right) right = textRight;
  }
  return right - originXMm;
}
