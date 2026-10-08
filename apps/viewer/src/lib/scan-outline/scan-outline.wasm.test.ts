/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan outline (#6871) through the real wasm engine, from slab points in
 * drawing space to the rings the canvas draws and the DXF export writes:
 * a 6 m × 4 m room scanned on both wall faces comes back as an outer ring and
 * a hole on the true faces, and the DXF puts them on the SCAN-OUTLINE layer
 * at exactly the georeferenced coordinates the cut itself gets (one shared
 * `buildDxfExportTransform`). Skips (never fails) when
 * `packages/wasm/pkg/ifc-lite_bg.wasm` is not built on this host.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWasm, roomSlab } from '@/test/scan-slab-fixture';
import { exportToDXF, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D, type DxfEntity } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import { buildDxfExportTransform } from '@/hooks/dxfExportGeoref';
import { scanOutlineDxfLayers, traceScanOutlineLayer, SCAN_OUTLINE_DXF_LAYER } from './scan-outline';

const FACES_X = [20, 26, 19.8, 26.2];
const FACES_Y = [30, 34, 29.8, 34.2];
const faceDistance = (p: { x: number; y: number }) =>
  Math.min(...FACES_X.map((x) => Math.abs(p.x - x)), ...FACES_Y.map((y) => Math.abs(p.y - y)));

describe('scan outline through the real wasm engine (#6871)', () => {
  it('traces the room as an outer ring and a hole on the true wall faces', (t) => {
    if (!ensureWasm(t)) return;
    const layer = traceScanOutlineLayer(roomSlab(), 0.3);
    assert.deepEqual(layer.rings.map((r) => r.length), [4, 4]);
    assert.deepEqual(layer.holes, [false, true]);
    assert.equal(layer.diagnostics.ringCount, 2);
    for (const p of layer.rings.flat()) {
      assert.ok(faceDistance(p) < 0.015, `vertex (${p.x}, ${p.y}) is ${faceDistance(p)} m off the walls`);
    }
  });

  it('writes the rings on their own DXF layer through the cut\'s georeference transform', (t) => {
    if (!ensureWasm(t)) return;
    const layer = traceScanOutlineLayer(roomSlab(), 0.3);
    const coordinateInfo = {
      wasmRtcOffset: { x: 1000, y: 2000, z: 0 },
      originShift: { x: 3, y: 0, z: -7 },
    } as unknown as GeometryResult['coordinateInfo'];
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference: {
        mapConversion: {
          id: 1, sourceCRS: 1, targetCRS: 1, eastings: 2_600_000, northings: 1_200_000,
          orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
        },
        projectedCRS: { id: 1, name: 'EPSG:2056', mapUnit: 'METRE', mapUnitScale: 1 },
        lengthUnitScale: 1,
      },
    });
    const drawing: Drawing2D = {
      config: { ...DEFAULT_SECTION_CONFIG, plane: { axis: 'y', position: 0, flipped: false }, scale: 100 },
      lines: [], cutPolygons: [], projectionPolygons: [],
      bounds: { min: { x: 0, y: 0 }, max: { x: 30, y: 40 } },
      stats: {
        cutLineCount: 0, projectionLineCount: 0, hiddenLineCount: 0, silhouetteLineCount: 0,
        polygonCount: 0, totalTriangles: 0, processingTimeMs: 0,
      },
    };
    const doc = parseDxf(exportToDXF(drawing, { coordinateTransform: transform, polylineLayers: scanOutlineDxfLayers(layer) }));
    const polys = doc.entities.filter((e): e is Extract<DxfEntity, { kind: 'polyline' }> => e.kind === 'polyline');
    assert.equal(polys.length, 2);
    polys.forEach((poly, r) => {
      assert.equal(poly.layer, SCAN_OUTLINE_DXF_LAYER);
      assert.equal(poly.closed, true);
      poly.vertices.forEach((v, k) => {
        const want = transform(layer.rings[r][k]);
        assert.ok(Math.abs(v.x - want.x) < 1e-6 && Math.abs(v.y - want.y) < 1e-6, `ring ${r} vertex ${k}`);
      });
    });
    // Map coordinates, not drawing coordinates: E = 2 600 000 + 1003 + x.
    assert.ok(polys[0].vertices.every((v) => v.x > 2_600_000 && v.y > 1_200_000));
  });

  it('gives no layer for an empty slab', (t) => {
    if (!ensureWasm(t)) return;
    const layer = traceScanOutlineLayer(new Float32Array(), 0.3);
    assert.equal(layer.rings.length, 0);
    assert.deepEqual(scanOutlineDxfLayers(layer), []);
  });
});
