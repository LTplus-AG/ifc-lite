/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { generateFloorPlan } from './drawing-generator.js';
import { storeyCutElevation } from './index.js';

type V3 = [number, number, number];

function box(expressId: number, min: V3, max: V3): MeshData {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]);
  return { expressId, ifcType: 'IfcWall', modelIndex: 0, positions, normals: new Float32Array(positions.length), indices, color: [1, 1, 1, 1] };
}

// rvt01.ifc (Revit): IfcSite at Z 14.23, storey "GR_GROUND FLOOR FFL" Elevation 0.5,
// meshes re-based by a wasm RTC offset of Z 14.73, so that floor sits at render Y 0.
const revitFrame = { wasmRtcOffset: { x: 500373.11, y: 2780223.98, z: 14.73 }, siteOrigin: { x: 500373.11, y: 2780223.98, z: 14.23 } };

describe('storey-relative plan cut in the render frame (#10931)', () => {
  it('cuts 1.2 m above the storey floor of a re-based model', () => {
    expect(storeyCutElevation(0.5, 1.2, revitFrame)).toBeCloseTo(1.2, 9);
  });

  it('adds the building placement Z, since IfcBuildingStorey.Elevation is relative to the building', () => {
    expect(storeyCutElevation(0, 1.2, { siteOrigin: { x: 0, y: 0, z: 0 }, buildingOrigin: { z: 3 } })).toBeCloseTo(4.2, 9);
    expect(storeyCutElevation(0.5, 1.2, { ...revitFrame, wasmRtcOffset: { ...revitFrame.wasmRtcOffset, z: 17.73 }, buildingOrigin: { z: 3 } })).toBeCloseTo(1.2, 9);
  });

  it('takes the JS origin shift off as well', () => {
    expect(storeyCutElevation(3, 1.2, { originShift: { x: 0, y: 2, z: 0 } })).toBeCloseTo(2.2, 9);
    expect(storeyCutElevation(3)).toBeCloseTo(4.2, 9);
  });

  it('feeds generateFloorPlan a cut that crosses a parapet 1.5 m above that floor', async () => {
    const parapet = box(1, [0, 0, 0], [4, 1.5, 0.2]);
    const drawing = await generateFloorPlan([parapet], storeyCutElevation(0.5, 1.2, revitFrame), { useGPU: false, includeHiddenLines: false });
    expect(drawing.cutPolygons.filter((p) => p.entityId === 1)).toHaveLength(1);
  });
});
