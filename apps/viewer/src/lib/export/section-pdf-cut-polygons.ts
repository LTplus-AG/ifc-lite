/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cut polygons for the scaled (non-sheet) section PDF: filled and outlined
 * with the same styles the SVG exports use (`cut-polygon-style.ts`).
 *
 * Styles and geometry are prepared at click time (`prepareCutPolygonsPdf`) so
 * a colour change while jsPDF loads cannot leak into the export; drawing
 * (`drawCutPolygonsPdf`) runs inside the export job.
 */

import type { jsPDF } from 'jspdf';
import type { DrawingPolygon } from '@ifc-lite/drawing-2d';
import { getFillColorForType } from '@/components/viewer/drawing/ifc-fill-colors';
import {
  styleCutPolygons,
  type CutPolygonStyle,
  type CutPolygonStyleContext,
} from '@/components/viewer/drawing/cut-polygon-style';
import { pdfColor } from '@/lib/export/pdf-color';

type Point = { x: number; y: number };

export interface PdfCutPolygon {
  polygon: DrawingPolygon;
  style: CutPolygonStyle;
  /** Page-space rings that survived (outer first when drawn). */
  rings: Point[][];
  /** Outer ring and every hole survived, so an even-odd fill is safe. */
  fillable: boolean;
  /** Every ring was drawn, so the outline covers its entity's cut lines. */
  coversCutLines: boolean;
}

const finiteRing = (ring: Point[]) => ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

/**
 * Rings with a non-finite vertex are dropped (jsPDF throws on them). A polygon
 * is fillable only when its outer ring and every hole survived: a lost outer
 * ring or hole would otherwise paint an opening solid.
 */
export function prepareCutPolygonsPdf(
  polygons: readonly DrawingPolygon[],
  ctx: CutPolygonStyleContext,
  mapPoint: (x: number, y: number) => Point,
): PdfCutPolygon[] {
  return styleCutPolygons(polygons, ctx, ({ polygon: { outer, holes } }) => {
    const outerDrawn = outer.length >= 2 && finiteRing(outer);
    const usableHoles = holes.filter((ring) => ring.length >= 2);
    const drawnHoles = usableHoles.filter(finiteRing);
    const intact = outerDrawn && drawnHoles.length === usableHoles.length;
    return {
      rings: [...(outerDrawn ? [outer] : []), ...drawnHoles].map((ring) => ring.map((p) => mapPoint(p.x, p.y))),
      fillable: intact && outer.length >= 3,
      coversCutLines: intact,
    };
  }).map(({ polygon, style, geometry }) => ({ polygon, style, ...geometry }));
}

/** Two decimals is what jsPDF prints; rounding keeps one ExtGState per printed value. */
const roundOpacity = (value: number) => Math.round(Math.min(1, value) * 100) / 100;

/**
 * Set a fill or stroke colour and return its alpha. A colour jsPDF cannot
 * take (an unfinished hex, a name) falls back per polygon, so one bad
 * override cannot abort the whole export.
 */
function setColor(doc: jsPDF, kind: 'fill' | 'draw', color: string, fallback: string, warned: Set<string>): number {
  const parsed = pdfColor(color);
  if (!parsed && !warned.has(color) && warned.add(color)) console.warn(`[section PDF] colour ${JSON.stringify(color)} is not usable in a PDF, using ${fallback}`);
  const css = parsed?.color ?? fallback;
  if (kind === 'fill') doc.setFillColor(css);
  else doc.setDrawColor(css);
  return parsed?.alpha ?? 1;
}

/**
 * Fills first (even-odd, so holes stay open), then outlines on top. Graphics
 * state is saved and restored, so nothing leaks to the caller.
 */
export function drawCutPolygonsPdf(doc: jsPDF, polygons: readonly PdfCutPolygon[]): void {
  doc.saveGraphicsState();
  try {
    drawCutPolygons(doc, polygons);
  } finally {
    doc.restoreGraphicsState();
  }
}

function drawCutPolygons(doc: jsPDF, polygons: readonly PdfCutPolygon[]): void {
  doc.setLineCap('round');
  doc.setLineDashPattern([], 0);
  const warned = new Set<string>(); // one warning per bad colour, not per polygon
  const tracePath = (rings: Point[][]) => {
    for (const ring of rings) {
      doc.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) doc.lineTo(ring[i].x, ring[i].y);
      doc.close();
    }
  };

  for (const { polygon, rings, fillable, style } of polygons) {
    if (!fillable || !(style.fillOpacity > 0)) continue;
    const alpha = setColor(doc, 'fill', style.fillColor, getFillColorForType(polygon.ifcType), warned);
    const opacity = roundOpacity(style.fillOpacity * alpha);
    if (!(opacity > 0)) continue;
    doc.setGState(doc.GState({ opacity }));
    tracePath(rings);
    doc.fillEvenOdd();
  }

  // Outlines cover every surviving ring, as before fills existed. Zero width
  // hides the outline, as in the SVG; PDF would draw "0 w" as the thinnest
  // visible line.
  for (const { rings, style } of polygons) {
    if (rings.length === 0 || !(style.lineWeight > 0)) continue;
    const opacity = roundOpacity(setColor(doc, 'draw', style.strokeColor, '#000000', warned));
    if (!(opacity > 0)) continue;
    doc.setGState(doc.GState({ 'stroke-opacity': opacity }));
    doc.setLineWidth(style.lineWeight);
    tracePath(rings);
    doc.stroke();
  }
}
