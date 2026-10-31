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
import { pdfColor, type PdfColor } from '@/lib/export/pdf-color';

type Point = { x: number; y: number };

export interface PdfCutPolygon {
  polygon: DrawingPolygon;
  style: CutPolygonStyle;
  /** Page-space rings that survived (outer first when drawn). */
  rings: Point[][];
  /**
   * The outer ring is drawable and encloses area, and no hole of two or more
   * points has non-finite page coordinates (jsPDF cannot draw it; every other
   * hole fills as in the SVG). Then an even-odd fill is safe and the outline
   * stands in for the entity's cut lines.
   */
  fillable: boolean;
}

const finiteRing = (ring: Point[]) => ring.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
const drawableRing = (ring: Point[]) => ring.length >= 2 && finiteRing(ring);

/**
 * Whether a ring encloses area. Collinear or repeated points give zero only up
 * to float rounding, so the threshold scales with the ring's size, and the
 * area is taken relative to the first point: at survey coordinates (LV95 is
 * around 2.6e6 m) raw shoelace products lose the small area to rounding.
 */
function enclosesArea(ring: Point[]): boolean {
  const o = ring[0];
  let twiceArea = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    twiceArea += (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  return Math.abs(twiceArea) > 2e-9 * extent * extent;
}

/**
 * Rings that cannot be drawn are dropped: jsPDF throws on NaN and writes
 * Infinity as a broken operand.
 * See `fillable` for when a polygon is filled and covers its cut lines.
 */
export function prepareCutPolygonsPdf(
  polygons: readonly DrawingPolygon[],
  ctx: CutPolygonStyleContext,
  mapPoint: (x: number, y: number) => Point,
): PdfCutPolygon[] {
  // Everything is checked on page coordinates: that is what jsPDF receives,
  // and a huge but finite model value can still overflow there.
  const page = (ring: Point[]) => ring.map((p) => mapPoint(p.x, p.y));
  return styleCutPolygons(polygons, ctx, ({ polygon: { outer, holes } }) => {
    const pageOuter = page(outer);
    const pageHoles = holes.map(page);
    return {
      rings: [pageOuter, ...pageHoles].filter(drawableRing),
      fillable: drawableRing(pageOuter) && enclosesArea(pageOuter)
        && pageHoles.every((ring) => ring.length < 2 || finiteRing(ring)),
    };
  }).map(({ polygon, style, geometry }) => ({ polygon, style, ...geometry }));
}

/** Two decimals is what jsPDF prints; rounding keeps one ExtGState per printed value. */
const roundOpacity = (value: number) => Math.round(Math.min(1, value) * 100) / 100;

/** Resolved per export: each distinct colour is parsed, and warned about, once. */
type ColorCache = Map<string, PdfColor | null>;

/**
 * Set a fill or stroke colour and return its alpha. A colour jsPDF cannot
 * take (an unfinished hex, an invalid name) falls back per polygon, so one
 * bad override cannot abort the whole export.
 */
function setColor(doc: jsPDF, kind: 'fill' | 'draw', color: string, fallback: string, cache: ColorCache): number {
  const key = color.trim().toLowerCase();
  let parsed = cache.get(key);
  if (parsed === undefined) { // pdfColor returns null, never undefined
    parsed = pdfColor(color);
    cache.set(key, parsed);
    if (!parsed) console.warn(`[section PDF] colour ${JSON.stringify(color)} is not usable in a PDF; affected elements use their fallback colour`);
  }
  const css = parsed?.color ?? fallback;
  if (kind === 'fill') doc.setFillColor(css);
  else doc.setDrawColor(css);
  return parsed?.alpha ?? 1;
}

/**
 * Fills first (even-odd, so holes stay open), then outlines on top. The PDF
 * graphics state is saved and restored around it; jsPDF's own getters
 * (getLineWidth, getFillColor) may still report the last polygon's values.
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
  const colors: ColorCache = new Map();
  const tracePath = (rings: Point[][]) => {
    for (const ring of rings) {
      doc.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) doc.lineTo(ring[i].x, ring[i].y);
      doc.close();
    }
  };

  for (const { polygon, rings, fillable, style } of polygons) {
    if (!fillable || !(style.fillOpacity > 0)) continue;
    const alpha = setColor(doc, 'fill', style.fillColor, getFillColorForType(polygon.ifcType), colors);
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
    const opacity = roundOpacity(setColor(doc, 'draw', style.strokeColor, '#000000', colors));
    if (!(opacity > 0)) continue;
    doc.setGState(doc.GState({ 'stroke-opacity': opacity }));
    doc.setLineWidth(style.lineWeight);
    tracePath(rings);
    doc.stroke();
  }
}
