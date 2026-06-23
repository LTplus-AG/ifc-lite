/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-layer section-cap reconstruction on OPENING-CUT walls.
 *
 * Since #1311 the slicer emits each material layer as an OPEN band (the shared
 * interface planes are no longer capped, so the union stays watertight). The
 * 2D/3D section cap has to re-close each layer band at the interface chords.
 * A door/window opening splits every layer into disconnected solid chunks; the
 * reconstruction must close each chunk WITHOUT bridging the opening, otherwise
 * the 3D section cap is wrong/missing and the wall reads as hollow.
 */

import { describe, it, expect } from 'vitest';
import { PolygonBuilder } from './polygon-builder.js';
import { polygonSignedArea } from './math.js';
import type { CutSegment, Point2D, DrawingPolygon } from './types.js';

const RED: [number, number, number, number] = [1, 0, 0, 1]; // outer layer
const GREEN: [number, number, number, number] = [0, 1, 0, 1]; // core layer
const BLUE: [number, number, number, number] = [0, 0, 1, 1]; // inner layer

/**
 * Cut segments of ONE material layer of a wall, plan-cut. x = wall length,
 * y = wall thickness. `chunks` are the solid x-intervals that survive the
 * opening(s). `faceLo`/`faceHi` say whether this layer owns a broad wall face
 * at y=yLo / y=yHi (true only for the outermost / innermost layer); an interior
 * layer owns neither, so its section is just the chunk side-walls (jambs + wall
 * ends) — two disconnected vertical strips per chunk.
 */
function layerBand(
  chunks: Array<[number, number]>,
  yLo: number,
  yHi: number,
  faceLo: boolean,
  faceHi: boolean,
  entityId: number,
  color: [number, number, number, number],
): CutSegment[] {
  const segs: CutSegment[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number) =>
    segs.push({
      p0: { x: ax, y: ay, z: 0 }, p1: { x: bx, y: by, z: 0 },
      p0_2d: { x: ax, y: ay }, p1_2d: { x: bx, y: by },
      entityId, ifcType: 'IfcWall', modelIndex: 0, color,
    });
  for (const [a, b] of chunks) {
    seg(a, yLo, a, yHi); // side wall at x=a (wall end or opening jamb)
    seg(b, yLo, b, yHi); // side wall at x=b
    if (faceLo) seg(a, yLo, b, yLo); // broad face at y=yLo
    if (faceHi) seg(a, yHi, b, yHi); // broad face at y=yHi
  }
  return segs;
}

/** Ray-cast point-in-polygon (outer ring only) — for asserting an opening is empty. */
function pointInOuter(pt: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if (pi.y > pt.y !== pj.y > pt.y &&
        pt.x < ((pj.x - pi.x) * (pt.y - pi.y)) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
  }
  return inside;
}

const coversPoint = (polys: DrawingPolygon[], pt: Point2D) =>
  polys.some((p) => pointInOuter(pt, p.polygon.outer));

const areaOf = (polys: DrawingPolygon[]) =>
  polys.reduce((s, p) => s + Math.abs(polygonSignedArea(p.polygon.outer)), 0);

const byColor = (polys: DrawingPolygon[], c: [number, number, number, number]) =>
  polys.filter((p) => p.color && p.color.every((v, i) => v === c[i]));

describe('PolygonBuilder — opening-cut multilayer walls', () => {
  // Wall x∈[0,10], opening x∈[4,6]; solid chunks LEFT [0,4] and RIGHT [6,10].
  const LEFT: [number, number] = [0, 4];
  const RIGHT: [number, number] = [6, 10];
  const inOpening: Point2D = { x: 5, y: 0.4 }; // dead centre of the opening

  it('2-layer wall: each layer fills both chunks, opening stays empty', () => {
    // outer RED [0,0.2] owns the y=0 face; inner BLUE [0.2,0.4] owns the y=0.4 face.
    const segments = [
      ...layerBand([LEFT, RIGHT], 0, 0.2, true, false, 1, RED),
      ...layerBand([LEFT, RIGHT], 0.2, 0.4, false, true, 1, BLUE),
    ];
    const polys = new PolygonBuilder().buildPolygons(segments);

    expect(byColor(polys, RED)).toHaveLength(2);
    expect(byColor(polys, BLUE)).toHaveLength(2);
    // 4 chunks × (4 length × 0.2 thick) = 3.2
    expect(areaOf(polys)).toBeCloseTo(3.2, 5);
    expect(coversPoint(polys, inOpening)).toBe(false);
  });

  it('3-layer wall: INTERIOR core fills both chunks and does NOT bridge the opening', () => {
    // This is the regression: the core layer (no broad face) is four disconnected
    // vertical strips; a greedy nearest-endpoint stitch joins them ACROSS the
    // opening into one self-overlapping polygon, so the cut reads hollow.
    const segments = [
      ...layerBand([LEFT, RIGHT], 0.0, 0.2, true, false, 2, RED),   // outer
      ...layerBand([LEFT, RIGHT], 0.2, 0.6, false, false, 2, GREEN), // core (interior)
      ...layerBand([LEFT, RIGHT], 0.6, 0.8, false, true, 2, BLUE),  // inner
    ];
    const polys = new PolygonBuilder().buildPolygons(segments);

    const core = byColor(polys, GREEN);
    expect(core).toHaveLength(2); // one fill per solid chunk
    // each core chunk: 4 length × 0.4 thick = 1.6
    expect(areaOf(core)).toBeCloseTo(3.2, 5);
    // the opening must NOT be filled by ANY layer
    expect(coversPoint(polys, inOpening)).toBe(false);
    // every layer present, each as two chunks
    expect(byColor(polys, RED)).toHaveLength(2);
    expect(byColor(polys, BLUE)).toHaveLength(2);
  });

  it('rotated 3-layer wall: interface closure still tracks the (rotated) length axis', () => {
    // Rotate the whole section 30° so the interface lines are not axis-aligned —
    // the closure must follow the principal (length) axis, not world X/Y.
    const t = Math.PI / 6, cos = Math.cos(t), sin = Math.sin(t);
    const rot = (s: CutSegment): CutSegment => {
      const r = (p: { x: number; y: number }) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos });
      return { ...s, p0_2d: r(s.p0_2d), p1_2d: r(s.p1_2d) };
    };
    const segments = [
      ...layerBand([LEFT, RIGHT], 0.0, 0.2, true, false, 3, RED),
      ...layerBand([LEFT, RIGHT], 0.2, 0.6, false, false, 3, GREEN),
      ...layerBand([LEFT, RIGHT], 0.6, 0.8, false, true, 3, BLUE),
    ].map(rot);
    const polys = new PolygonBuilder().buildPolygons(segments);

    expect(byColor(polys, GREEN)).toHaveLength(2);
    expect(areaOf(byColor(polys, GREEN))).toBeCloseTo(3.2, 4);
    // opening centre, rotated into the same frame
    const oc = { x: 5 * cos - 0.4 * sin, y: 5 * sin + 0.4 * cos };
    expect(coversPoint(polys, oc)).toBe(false);
  });
});

describe('PolygonBuilder.buildBasePolygons — opaque section backstop', () => {
  const LEFT: [number, number] = [0, 4];
  const RIGHT: [number, number] = [6, 10];

  it('builds the full closed cross-section per layered entity (both chunks, opening empty)', () => {
    // Same 3-layer opening wall. The base ignores the per-layer split: combining
    // all bands drops the open interfaces and leaves the watertight outer skin,
    // which closes into the two solid chunks — no interface stitching needed.
    const segments = [
      ...layerBand([LEFT, RIGHT], 0.0, 0.2, true, false, 7, RED),
      ...layerBand([LEFT, RIGHT], 0.2, 0.6, false, false, 7, GREEN),
      ...layerBand([LEFT, RIGHT], 0.6, 0.8, false, true, 7, BLUE),
    ];
    const base = new PolygonBuilder().buildBasePolygons(segments);

    expect(base).toHaveLength(2);               // one per solid chunk
    for (const p of base) {
      expect(p.isLayerBase).toBe(true);
      expect(p.color).toBeUndefined();          // colourless ⇒ opaque uniform fill
    }
    // full wall section = 2 chunks × (4 length × 0.8 thickness) = 6.4
    expect(areaOf(base)).toBeCloseTo(6.4, 5);
    expect(coversPoint(base, { x: 5, y: 0.4 })).toBe(false); // opening stays empty
    // and it DOES cover where a layer fill belongs, so a missing layer reads solid
    expect(coversPoint(base, { x: 2, y: 0.4 })).toBe(true);
  });

  it('emits no base for a single-material entity (its normal fill is already solid)', () => {
    const segments = layerBand([[0, 10]], 0, 0.3, true, true, 8, RED);
    expect(new PolygonBuilder().buildBasePolygons(segments)).toHaveLength(0);
  });
});
