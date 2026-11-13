/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linear dimensions in the drawing exports: SVG (direct and sheet, and so
 * print and the sheet PDF), DXF and the vector PDF.
 *
 * Every writer draws the segments and text of {@link dimensionGraphics}, so
 * the outputs cannot disagree with each other or with the canvas. The only
 * per-writer work is the frame: each maps drawing points with its own point
 * mapper, and turns text so it reads upright in its own output frame (the
 * DXF output frame can be mirrored relative to paper; see `textLayers` in
 * `@ifc-lite/drawing-2d`).
 *
 * Callers pass only the dimensions on the cut now drawn
 * (`exportableDimensions`, via `useExportDimensions`); a dimension from another cut is left out of
 * every export, and the export menu says so (`drawing-export-omissions.ts`).
 */

import type { jsPDF } from 'jspdf';
import type { DXFPolylineLayer, DXFTextLayer } from '@ifc-lite/drawing-2d';
import type { Dimension2D } from '@/store/slices/drawing2DDimensions';
import {
  dimensionGraphics,
  type DimensionGraphics,
  type DimensionGraphicsOptions,
  type DimensionPt,
} from '@/lib/drawing2d-markup/dimension-graphics';

/** Stroke weights in paper millimetres: thin dimension and extension lines, heavier ticks. */
export const DIMENSION_STROKE_MM = { line: 0.18, tick: 0.35 } as const;
export const DIMENSION_COLOR = '#000000';
/** DXF layer for dimension lines, ticks and values. */
export const DIMENSION_DXF_LAYER = 'IFC-DIMENSIONS';

/** Maps a drawing point (metres, un-flipped) to an output point. */
export type DimensionMapPoint = (x: number, y: number) => DimensionPt;

/** The graphics of every dimension, in the order given. */
export function dimensionGraphicsList(dimensions: readonly Dimension2D[], options: DimensionGraphicsOptions): DimensionGraphics[] {
  return dimensions.map((dim) => dimensionGraphics(dim, options));
}

/** Where and how a dimension's text sits in a y-down output frame (SVG, PDF page). */
export interface PlacedDimensionText {
  x: number;
  y: number;
  /** Baseline angle in degrees, clockwise on the page (y down), in (-90, 90]: upright. */
  angleDeg: number;
  /** Text height in output units. */
  size: number;
}

/**
 * Place a dimension's text in an output frame whose y axis points down. The
 * baseline direction and size are measured through `map`, so any flip or
 * scale the writer applies carries over to the text.
 */
export function placeDimensionText(text: DimensionGraphics['text'], map: DimensionMapPoint): PlacedDimensionText {
  const at = map(text.at.x, text.at.y);
  const tip = map(text.at.x + Math.cos(text.angle) * text.heightM, text.at.y + Math.sin(text.angle) * text.heightM);
  let dx = tip.x - at.x;
  let dy = tip.y - at.y;
  // Upright on y-down paper: reading rightwards, or bottom to top when vertical.
  if (dx < -1e-12 || (Math.abs(dx) <= 1e-12 && dy > 0)) {
    dx = -dx;
    dy = -dy;
  }
  return { x: at.x, y: at.y, angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI + 0, size: Math.hypot(dx, dy) };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (v + 0).toFixed(4);

/**
 * The dimensions as one SVG group. `map` takes drawing points to SVG user
 * units; `mmToUnits` converts paper millimetres to those units (stroke weights).
 */
export function dimensionsToSvg(graphics: readonly DimensionGraphics[], map: DimensionMapPoint, mmToUnits: (mm: number) => number): string {
  if (graphics.length === 0) return '';
  const segment = ([p, q]: readonly [DimensionPt, DimensionPt], width: number) => {
    const a = map(p.x, p.y);
    const b = map(q.x, q.y);
    return `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke-width="${n(width)}"/>`;
  };
  const lineW = mmToUnits(DIMENSION_STROKE_MM.line);
  const tickW = mmToUnits(DIMENSION_STROKE_MM.tick);
  let svg = `  <g id="dimensions" stroke="${DIMENSION_COLOR}" stroke-linecap="butt" fill="none">\n`;
  for (const g of graphics) {
    const t = placeDimensionText(g.text, map);
    svg += '    <g class="dimension">';
    svg += g.lines.map((s) => segment(s, lineW)).join('') + g.ticks.map((s) => segment(s, tickW)).join('');
    svg += `<text x="${n(t.x)}" y="${n(t.y)}" transform="rotate(${n(t.angleDeg)} ${n(t.x)} ${n(t.y)})" font-family="Arial, sans-serif" font-size="${n(t.size)}" fill="${DIMENSION_COLOR}" stroke="none" text-anchor="middle" dominant-baseline="central">${xml(g.text.value)}</text>`;
    svg += '</g>\n';
  }
  return svg + '  </g>\n';
}

/**
 * The dimensions as DXF layers for `exportToDXF`'s `polylineLayers` and
 * `textLayers`, in drawing space: the exporter applies its own
 * `coordinateTransform`, and keeps the values upright in the output frame.
 */
export function dimensionsToDxfLayers(graphics: readonly DimensionGraphics[]): { polylineLayers: DXFPolylineLayer[]; textLayers: DXFTextLayer[] } {
  if (graphics.length === 0) return { polylineLayers: [], textLayers: [] };
  return {
    polylineLayers: [{
      name: DIMENSION_DXF_LAYER,
      color: DIMENSION_COLOR,
      closed: false,
      polylines: graphics.flatMap((g) => [...g.lines, ...g.ticks]),
    }],
    textLayers: [{
      name: DIMENSION_DXF_LAYER,
      color: DIMENSION_COLOR,
      texts: graphics.map((g) => ({
        position: g.text.at,
        text: g.text.value,
        height: g.text.heightM,
        direction: { x: Math.cos(g.text.angle), y: Math.sin(g.text.angle) },
        keepUpright: true,
        hAlign: 'center' as const,
        vAlign: 'middle' as const,
      })),
    }],
  };
}

const PT_PER_MM = 72 / 25.4;
/** Cap height of the standard PDF Helvetica, in ems. */
const CAP_HEIGHT_EM = 0.718;

/** Draw the dimensions on a jsPDF page in millimetres; `map` takes drawing points to page mm (y down). */
export function drawDimensionsPdf(doc: jsPDF, graphics: readonly DimensionGraphics[], map: DimensionMapPoint): void {
  if (graphics.length === 0) return;
  doc.saveGraphicsState();
  doc.setDrawColor(DIMENSION_COLOR);
  doc.setTextColor(DIMENSION_COLOR);
  doc.setLineDashPattern([], 0);
  doc.setLineCap('butt');
  const stroke = (segments: readonly (readonly [DimensionPt, DimensionPt])[], widthMm: number) => {
    doc.setLineWidth(widthMm);
    for (const [p, q] of segments) {
      const a = map(p.x, p.y);
      const b = map(q.x, q.y);
      doc.line(a.x, a.y, b.x, b.y);
    }
  };
  for (const g of graphics) {
    stroke(g.lines, DIMENSION_STROKE_MM.line);
    stroke(g.ticks, DIMENSION_STROKE_MM.tick);
    const t = placeDimensionText(g.text, map);
    doc.setFontSize(t.size * PT_PER_MM);
    // jsPDF applies `align`/`baseline` along the page axes, not along a
    // rotated baseline, so place the start of the baseline here: back half
    // the width along it, and half a cap height down across it.
    const rad = (t.angleDeg * Math.PI) / 180;
    const along = { x: Math.cos(rad), y: Math.sin(rad) };
    const down = { x: -along.y, y: along.x };
    const half = doc.getTextWidth(g.text.value) / 2;
    const drop = CAP_HEIGHT_EM * t.size / 2;
    // jsPDF angles turn counter-clockwise as seen on the page.
    doc.text(g.text.value, t.x - along.x * half + down.x * drop, t.y - along.y * half + down.y * drop, { angle: -t.angleDeg });
  }
  doc.restoreGraphicsState();
}
