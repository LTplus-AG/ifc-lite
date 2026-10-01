/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { DXF_TEXT_LINE_HEIGHT_FACTOR } from '@/lib/drawing/dxf-text-layout';
import type { Drawing2D, Point2D } from '@ifc-lite/drawing-2d';
import type { DxfUnderlayRenderData } from './dxfUnderlayMath';

/** Fit, sheet layout and exports share these immutable displayed extents. */
export function drawingWithDxfBounds(drawing: Drawing2D | null, references: readonly DxfUnderlayRenderData[], hasRasterReferences = false): Drawing2D | null {
  if (!drawing || !references.length) return drawing;
  const hasGeometry=hasRasterReferences || drawing.lines.length > 0 || drawing.cutPolygons.length > 0 || drawing.projectionPolygons.length > 0;
  const bounds=hasGeometry ? {min:{...drawing.bounds.min},max:{...drawing.bounds.max}} : {min:{x:Infinity,y:Infinity},max:{x:-Infinity,y:-Infinity}};
  const include=(point:Point2D)=>{
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    bounds.min.x=Math.min(bounds.min.x,point.x); bounds.min.y=Math.min(bounds.min.y,point.y);
    bounds.max.x=Math.max(bounds.max.x,point.x); bounds.max.y=Math.max(bounds.max.y,point.y);
  };
  for (const reference of references) {
    for (const line of reference.lines) for (const point of line.points) include(point);
    for (const fill of reference.fills) for (const loop of fill.loops) for (const point of loop) include(point);
    for (const text of reference.texts) {
      // Conservative glyph envelope; source DXF text height is metric and width
      // varies by font. Include baseline and height in the mapped direction.
      const length=Math.hypot(text.dirX,text.dirY)||1, ux=text.dirX/length,uy=text.dirY/length;
      const lines = text.text.split('\n');
      const width = text.height * lines.reduce((longest, line) => Math.max(longest, line.length), 0);
      const left = text.align === 'right' ? -width : text.align === 'center' ? -width / 2 : 0;
      // Cardinal display/export mappings may reverse the stacking perpendicular.
      // Cover both directions and one glyph height beyond the final baseline.
      const extent = text.height * (1 + (lines.length - 1) * DXF_TEXT_LINE_HEIGHT_FACTOR);
      for (const x of [left,left+width]) for (const y of [-extent,extent]) include({x:text.x+ux*x-uy*y,y:text.y+uy*x+ux*y});
    }
  }
  return Number.isFinite(bounds.min.x) ? {...drawing,bounds} : drawing;
}

/** Empty generated geometry has no model centre, even when display references
 * have enlarged its derived bounds. A one-dimensional section still has one. */
export function drawingModelCenter(drawing: Drawing2D | null | undefined): Point2D | null {
  if (!drawing || (!drawing.lines.length && !drawing.cutPolygons.length && !drawing.projectionPolygons.length)) return null;
  const { min, max } = drawing.bounds;
  if (![min.x, min.y, max.x, max.y].every(Number.isFinite)
    || max.x < min.x || max.y < min.y || (max.x === min.x && max.y === min.y)) return null;
  return { x: min.x / 2 + max.x / 2, y: min.y / 2 + max.y / 2 };
}
