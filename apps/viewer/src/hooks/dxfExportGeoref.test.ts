/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF export georeferencing (issue #1861): the drawing-space -> world/map
 * coordinate transform used when downloading a plan ('down') section as
 * DXF. Verifies the inversion of `dxfUnderlayMath.ts`'s `worldToDrawing`
 * against the same fixture values `dxfUnderlayMath.test.ts` uses, plus a
 * full round trip through the real DXF writer + parser (`@ifc-lite/drawing-2d`)
 * to prove a known drawing point lands at the expected world/map
 * coordinate in the exported file, not just in the pure transform function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToDXF, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D } from '@ifc-lite/drawing-2d';
import { buildDxfExportTransform } from './dxfExportGeoref.js';
import type { GeometryResult } from '@ifc-lite/geometry';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be close to ${b}`);

const coordinateInfo = {
  wasmRtcOffset: { x: 1000, y: 2000, z: 0 },
  originShift: { x: 3, y: 0, z: -7 },
} as unknown as GeometryResult['coordinateInfo'];
// Per dxfUnderlayMath.test.ts: shift.x = rtc.x + originShift.x = 1003,
// shift.y = rtc.y - originShift.z = 2007.

describe('buildDxfExportTransform', () => {
  it('is the identity for elevation/side sections (no 2D CAD georeference meaning)', () => {
    for (const axis of ['front', 'side'] as const) {
      const transform = buildDxfExportTransform({
        coordinateInfo,
        sectionAxis: axis,
        isCustomPlane: false,
        flipped: false,
      });
      const p = { x: 12.5, y: -7.25 };
      const out = transform(p);
      close(out.x, p.x);
      close(out.y, p.y);
    }
  });

  it('is the identity for a custom (arbitrary-plane) plan section', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: true,
      flipped: false,
    });
    const p = { x: 1, y: 2 };
    assert.deepStrictEqual(transform(p), p);
  });

  it('re-derives true IFC world coordinates for an un-flipped plan section', () => {
    // world_x = drawing_x + shift.x; world_y = shift.y - drawing_y.
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
    });
    const world = transform({ x: 4, y: 6 });
    close(world.x, 4 + 1003);
    close(world.y, 2007 - 6);
  });

  it('mirrors X for a flipped plan section before adding the shift', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: true,
    });
    const world = transform({ x: 4, y: 6 });
    close(world.x, -4 + 1003);
    close(world.y, 2007 - 6);
  });

  it('applies IfcMapConversion (translation + rotation + scale) on top of the world coordinate', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference: {
        mapConversion: {
          id: 1,
          sourceCRS: 1,
          targetCRS: 1,
          eastings: 500_000,
          northings: 6_000_000,
          orthogonalHeight: 0,
          xAxisAbscissa: 0, // cos(90deg)
          xAxisOrdinate: 1, // sin(90deg): 90-degree rotation
          scale: 1,
        },
        projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
        lengthUnitScale: 1,
      },
    });
    // world point (after un-shift/un-flip) is (4 + 1003, 2007 - 6) = (1007, 2001).
    // With a 90deg rotation (abscissa=0, ordinate=1), scale=1:
    // easting  = 500000 + (0*1007 - 1*2001) = 500000 - 2001
    // northing = 6000000 + (1*1007 + 0*2001) = 6000000 + 1007
    const out = transform({ x: 4, y: 6 });
    close(out.x, 500_000 - 2001);
    close(out.y, 6_000_000 + 1007);
  });
});

function emptyDrawing(): Drawing2D {
  return {
    config: { ...DEFAULT_SECTION_CONFIG, scale: 100, plane: { axis: 'y', position: 0, flipped: false } },
    lines: [],
    cutPolygons: [],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 0,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 0,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

describe('DXF export georeference round trip (through the real writer + parser)', () => {
  it('a known plan-drawing point lands at the expected world coordinate in the exported DXF', () => {
    const drawing = emptyDrawing();
    drawing.lines = [
      {
        line: { start: { x: 4, y: 6 }, end: { x: 4, y: 6 } },
        category: 'cut',
        visibility: 'visible',
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        depth: 0,
      },
    ];
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
    });
    const dxf = exportToDXF(drawing, { coordinateTransform: transform });
    const doc = parseDxf(dxf);
    assert.strictEqual(doc.insunits, 6); // metres
    const line = doc.entities.find((e) => e.kind === 'line');
    assert.ok(line && line.kind === 'line');
    close(line.x1, 4 + 1003);
    close(line.y1, 2007 - 6);
  });
});
