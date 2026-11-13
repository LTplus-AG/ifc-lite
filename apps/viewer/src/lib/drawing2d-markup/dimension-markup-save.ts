/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn the store's `Dimension2D`s into what `@ifc-lite/create`'s
 * `addDimensionMarkupToStore` writes: the dimension's own fields plus its
 * drawn graphics, laid out by the same `dimensionGraphics` the canvas and the
 * exports use, so the embedded annotation looks as drawn.
 *
 * Every dimension is saved, including one drawn on another cut: unlike an
 * export (which leaves those out), the model is where markup persists, and
 * the saved `Plane` keeps the other-cut rule working after a reload. A
 * dimension's graphics are laid out with its own cut's section flip, falling
 * back to the drawn cut for an unstamped one.
 */

import type { DimensionMarkupParams } from '@ifc-lite/create';
import { axisFlipForSection } from '@/hooks/pdfSectionLayout';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import type { DrawnSectionPlane } from '@/store/slices/drawing2DSlice';
import { dimensionGraphics, formatDimensionValue } from './dimension-graphics.js';
import { encodeDimensionPlane, encodeDimensionRef } from './dimension-markup-codec.js';

export type DimensionSaveParams = { id: string } & DimensionMarkupParams;

export interface DimensionSaveLayout {
  /** Drawing scale denominator: `activeSheet.scale.factor` with a sheet, else `drawing2DDisplayOptions.scale`. */
  paperScale: number;
  unitDisplayOverrides?: Record<string, string>;
  /** The cut on screen (`drawing2DPlane`), for dimensions without their own stamp. */
  drawnPlane?: DrawnSectionPlane | null;
}

/** The paper scale a dimension is drawn at, from the store fields that choose it. */
export function dimensionPaperScale(state: {
  sheetEnabled: boolean;
  activeSheet: { scale: { factor: number } } | null;
  drawing2DDisplayOptions: { scale: number };
}): number {
  return state.sheetEnabled && state.activeSheet ? state.activeSheet.scale.factor : state.drawing2DDisplayOptions.scale;
}

export function dimensionSaveParams(dim: Dimension2D, layout: DimensionSaveLayout): DimensionSaveParams {
  const plane = dim.plane ?? layout.drawnPlane ?? undefined;
  const graphics = dimensionGraphics(dim, {
    paperScale: layout.paperScale,
    format: (metres) => formatDimensionValue(metres, layout.unitDisplayOverrides),
    flip: plane ? axisFlipForSection(plane.axis) : undefined,
  });
  return {
    id: dim.id,
    a: dim.a,
    b: dim.b,
    distance: graphics.measured,
    offset: dim.offset,
    orientation: dim.orientation,
    lines: graphics.lines,
    ticks: graphics.ticks,
    label: {
      position: graphics.text.at,
      value: graphics.text.value,
      angle: graphics.text.angle,
      height: graphics.text.heightM,
    },
    ...(dim.text !== undefined ? { text: dim.text } : {}),
    ...(dim.refs?.a ? { refA: encodeDimensionRef(dim.refs.a) } : {}),
    ...(dim.refs?.b ? { refB: encodeDimensionRef(dim.refs.b) } : {}),
    ...(dim.plane ? { plane: encodeDimensionPlane(dim.plane) } : {}),
  };
}

const finitePoint = (p: { x: number; y: number }) => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * What `addDimensionMarkupToStore` would throw on, checked without writing
 * (see `drawing-markup-save.ts`'s `findInvalidMarkup` for why a save
 * pre-validates). Returns the problem, or `null`.
 */
export function findInvalidDimension(d: DimensionMarkupParams): string | null {
  if (!finitePoint(d.a) || !finitePoint(d.b)) return 'has a non-finite point';
  if (!Number.isFinite(d.distance) || d.distance < 0) return 'has a non-finite or negative value';
  if (!Number.isFinite(d.offset)) return 'has a non-finite offset';
  if (![...d.lines, ...d.ticks].every(([p, q]) => finitePoint(p) && finitePoint(q))) return 'has a non-finite drawn line';
  const { label } = d;
  if (!finitePoint(label.position) || !Number.isFinite(label.angle) || !Number.isFinite(label.height) || label.height < 0) {
    return 'has a non-finite text placement';
  }
  return null;
}
