/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The geometry of a linear dimension, computed once for every output: the
 * canvas, SVG, DXF and PDF exports and the IFC embed all draw from
 * {@link dimensionGraphics} so they cannot disagree.
 *
 * Everything is in drawing metres, in the un-flipped drawing space the store
 * keeps (`Dimension2D.a`/`b`). Sizes are given in paper millimetres and scaled
 * by the paper scale (1:`paperScale`), so a dimension keeps its look on paper
 * at any drawing scale. The paper frame is the drawing frame after the
 * section flip (`axisFlipForSection`), with y pointing down, as on screen and
 * in SVG; text is turned so it reads upright in that frame.
 *
 * Layout follows the linear/aligned dimension of BIMvoice/ifc-sheet's
 * `dimension-layout.ts` (MPL-2.0), rewritten for this data model: an offset
 * instead of a through-point, and architectural ticks.
 */

import { QuantityType } from '@ifc-lite/data';
import { ProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay, formatConverted } from '@/lib/units/display';
import { measuredDimensionValue, type Dimension2D } from '@/store/slices/drawing2DDimensions';

export interface DimensionPt {
  x: number;
  y: number;
}

export type DimensionSegment = [DimensionPt, DimensionPt];

/** Paper sizes in millimetres. */
export const DIMENSION_PAPER_MM = {
  /** Gap between a measured point and its extension line. */
  extensionGap: 1,
  /** How far an extension line runs past the dimension line. */
  extensionOvershoot: 2,
  /** Length of a 45° tick. */
  tick: 2.5,
  /** Text height. */
  textHeight: 2.5,
  /** Gap between the dimension line and the text. */
  textGap: 1,
} as const;

export interface DimensionGraphicsOptions {
  /** Drawing scale denominator (100 for 1:100): `activeSheet.scale.factor` with a sheet, else `drawing2DDisplayOptions.scale`. */
  paperScale: number;
  /** Formats the measured value in metres, e.g. {@link formatDimensionValue}. */
  format: (metres: number) => string;
  /** The section flip the drawing is shown with (`axisFlipForSection`). Omitted: no flip, as for a plan. */
  flip?: { flipX: boolean; flipY: boolean };
}

export interface DimensionGraphics {
  /** `lines[0]` is the dimension line; extension lines follow, one per measured point off the line. */
  lines: DimensionSegment[];
  /** One 45° tick per end of the dimension line. */
  ticks: DimensionSegment[];
  text: {
    /** Centre of the text box. */
    at: DimensionPt;
    /** Baseline direction in drawing space, radians. */
    angle: number;
    /** Baseline direction in the flipped, y-down paper frame, radians in [-π/2, π/2): upright text (vertical text reads bottom to top). */
    paperAngle: number;
    heightM: number;
    value: string;
  };
  /** The measured length in metres. */
  measured: number;
}

const EPS = 1e-12;

const add = (p: DimensionPt, q: DimensionPt): DimensionPt => ({ x: p.x + q.x, y: p.y + q.y });
const scale = (p: DimensionPt, k: number): DimensionPt => ({ x: p.x * k, y: p.y * k });
const dot = (p: DimensionPt, q: DimensionPt): number => p.x * q.x + p.y * q.y;
function unit(v: DimensionPt, fallback: DimensionPt): DimensionPt {
  const l = Math.hypot(v.x, v.y);
  return l > EPS ? { x: v.x / l, y: v.y / l } : fallback;
}

/** The text a dimension shows: the formatted value, or the override with each `<>` replaced by it. */
export function dimensionText(text: string | undefined, formatted: string): string {
  return text === undefined ? formatted : text.split('<>').join(formatted);
}

export function dimensionGraphics(dim: Dimension2D, options: DimensionGraphicsOptions): DimensionGraphics {
  const mm = (paperMm: number) => (paperMm * options.paperScale) / 1000;
  const gap = mm(DIMENSION_PAPER_MM.extensionGap);
  const over = mm(DIMENSION_PAPER_MM.extensionOvershoot);
  const tickHalf = mm(DIMENSION_PAPER_MM.tick) / 2;
  const heightM = mm(DIMENSION_PAPER_MM.textHeight);

  const { a, b } = dim;
  const dir = dim.orientation === 'horizontal' ? { x: 1, y: 0 }
    : dim.orientation === 'vertical' ? { x: 0, y: 1 }
      : unit({ x: b.x - a.x, y: b.y - a.y }, { x: 1, y: 0 });
  const n = { x: -dir.y, y: dir.x };
  const mid = scale(add(a, b), 0.5);
  const offA = dim.offset + dot({ x: mid.x - a.x, y: mid.y - a.y }, n);
  const offB = dim.offset + dot({ x: mid.x - b.x, y: mid.y - b.y }, n);
  const pa = add(a, scale(n, offA));
  const pb = add(b, scale(n, offB));

  const lines: DimensionSegment[] = [[pa, pb]];
  for (const [p, foot, off] of [[a, pa, offA], [b, pb, offB]] as const) {
    if (Math.abs(off) <= EPS) continue;
    const s = Math.sign(off);
    lines.push([add(p, scale(n, s * Math.min(gap, Math.abs(off)))), add(foot, scale(n, s * over))]);
  }

  // Work out the reading direction on paper, then map it back. The flip is
  // its own inverse, so one function maps both ways.
  const fx = options.flip?.flipX ? -1 : 1;
  const fy = options.flip?.flipY ? -1 : 1;
  const paper = (v: DimensionPt): DimensionPt => ({ x: v.x * fx, y: v.y * fy });
  let along = paper(unit({ x: pb.x - pa.x, y: pb.y - pa.y }, dir));
  // Upright on y-down paper: pointing right, or straight up for vertical text.
  if (along.x < -1e-9 || (Math.abs(along.x) <= 1e-9 && along.y > 0)) along = scale(along, -1);
  const upPaper = { x: along.y, y: -along.x };
  const tickPaper = scale(add(along, upPaper), Math.SQRT1_2);
  const alongD = paper(along);
  const upD = paper(upPaper);
  const tickD = paper(tickPaper);

  const ticks: DimensionSegment[] = [pa, pb].map((foot): DimensionSegment => [
    add(foot, scale(tickD, -tickHalf)),
    add(foot, scale(tickD, tickHalf)),
  ]);

  const measured = measuredDimensionValue(dim);
  return {
    lines,
    ticks,
    text: {
      at: add(scale(add(pa, pb), 0.5), scale(upD, mm(DIMENSION_PAPER_MM.textGap) + heightM / 2)),
      angle: Math.atan2(alongD.y, alongD.x),
      paperAngle: Math.atan2(along.y, along.x),
      heightM,
      value: dimensionText(dim.text, options.format(measured)),
    },
    measured,
  };
}

// Distances in the drawing are already metres; resolve against an empty unit
// context, as `formatDistance` does, so a file's declared unit never rescales them.
const EMPTY_UNITS = ProjectUnits.empty();

/**
 * The value a dimension prints: whole millimetres with no unit (4.2624 m reads
 * `4262`) unless the viewer has a length display unit set, which then applies
 * with its symbol (`4.2624 m`).
 */
export function formatDimensionValue(metres: number, unitDisplayOverrides: Record<string, string> = {}): string {
  const disp = resolveQuantityDisplay(metres, QuantityType.Length, EMPTY_UNITS, unitDisplayOverrides);
  if (disp.converted === null) return String(Math.round(metres * 1000) + 0);
  const formatted = formatConverted(disp.converted);
  return disp.unit ? `${formatted} ${disp.unit}` : formatted;
}
