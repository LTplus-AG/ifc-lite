/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { RenderFrameOffsets } from '../../components/viewer/tools/measure-modes/coordinates.js';
import { computeEntityLocalCenter, computeEntityWorldCenterZup } from './entity-world-position.js';

/** Minimal synthetic GeometryResult with one mesh's positions given as an
 *  explicit vertex list so the bounding box is easy to hand-verify. */
function fixture(expressId: number, verts: Array<[number, number, number]>, origin?: [number, number, number]): GeometryResult {
  const positions = new Float32Array(verts.flat());
  return {
    meshes: [{
      expressId,
      positions,
      origin,
    } as GeometryResult['meshes'][number]],
    totalTriangles: 0,
    totalVertices: verts.length,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      hasLargeCoordinates: false,
    },
  };
}

describe('computeEntityLocalCenter', () => {
  it('returns the bounding-box center of the matching mesh (Y-up, renderer frame)', () => {
    // Vertices span [0,2] x [0,4] x [0,6] -> center (1,2,3).
    const geo = fixture(5, [[0, 0, 0], [2, 0, 0], [0, 4, 0], [0, 0, 6]]);
    assert.deepEqual(computeEntityLocalCenter(geo, 5), { x: 1, y: 2, z: 3 });
  });

  it('folds the per-mesh origin into the bounding box', () => {
    // Same vertex spread, but origin shifts everything by (10, 20, 30):
    // bbox becomes [10,12] x [20,24] x [30,36] -> center (11, 22, 33).
    const geo = fixture(5, [[0, 0, 0], [2, 0, 0], [0, 4, 0], [0, 0, 6]], [10, 20, 30]);
    assert.deepEqual(computeEntityLocalCenter(geo, 5), { x: 11, y: 22, z: 33 });
  });

  it('returns null when no mesh matches the target expressId', () => {
    const geo = fixture(5, [[0, 0, 0], [2, 2, 2]]);
    assert.equal(computeEntityLocalCenter(geo, 999), null);
  });

  it('returns null when the geometry result has no meshes', () => {
    const geo: GeometryResult = { ...fixture(5, [[0, 0, 0]]), meshes: [] };
    assert.equal(computeEntityLocalCenter(geo, 5), null);
  });

  it('returns null for a null/undefined geometry result', () => {
    assert.equal(computeEntityLocalCenter(null, 5), null);
    assert.equal(computeEntityLocalCenter(undefined, 5), null);
  });
});

describe('computeEntityWorldCenterZup', () => {
  it('with no RTC offset and no origin shift, returns the local bbox center, Z-up-flipped (un-georeferenced model)', () => {
    // Local (Y-up) center (1, 2, 3); no frame shift applied.
    // viewerToIfcAxes: {x: p.x, y: -p.z, z: p.y} => {x: 1, y: -3, z: 2}.
    const geo = fixture(5, [[0, 0, 0], [2, 0, 0], [0, 4, 0], [0, 0, 6]]);
    const frame: RenderFrameOffsets = {};
    assert.deepEqual(computeEntityWorldCenterZup(geo, 5, frame), { x: 1, y: -3, z: 2 });
  });

  it('applies a non-trivial RTC offset + origin shift with the correct axis remap', () => {
    // Local (Y-up) center: vertices span [9,11] x [19,21] x [29,31] -> (10, 20, 30).
    const geo = fixture(5, [[9, 19, 29], [11, 21, 31]]);
    // originShift is recorded in renderer (Y-up) axes.
    // wasmRtcOffsetIfc is recorded in IFC (Z-up) axes: {x:100, y:200, z:300}.
    // Converted to renderer axes: ifcToViewerAxes -> {x:100, y:300, z:-200}.
    // worldYup = local + shift + rtcViewer
    //          = (10+1+100, 20+2+300, 30+3-200) = (111, 322, -167).
    // viewerToIfcAxes(worldYup) = {x:111, y: -(-167)=167, z:322}.
    const frame: RenderFrameOffsets = {
      originShift: { x: 1, y: 2, z: 3 },
      wasmRtcOffsetIfc: { x: 100, y: 200, z: 300 },
    };
    assert.deepEqual(computeEntityWorldCenterZup(geo, 5, frame), { x: 111, y: 167, z: 322 });
  });

  it('returns null when the element has no matching mesh (not decoded / no geometry)', () => {
    const geo = fixture(5, [[0, 0, 0], [2, 2, 2]]);
    const frame: RenderFrameOffsets = { originShift: { x: 1, y: 1, z: 1 } };
    assert.equal(computeEntityWorldCenterZup(geo, 999, frame), null);
  });
});
