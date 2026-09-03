/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { RenderFrameOffsets } from '../../components/viewer/tools/measure-modes/coordinates.js';
import { computeEntityLocalCenter, computeEntityWorldCenterZup, makeWorldPositionGetter } from './entity-world-position.js';

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

  // Kills the mutation "drop the `minX === Infinity` guard". A matched mesh with
  // zero vertices leaves the extents at +/-Infinity and returns NaN on all three
  // axes. NaN is worse than blank here: the list comparator does `a - b`, so an
  // inconsistent comparator scrambles the ordering of the WHOLE table, `gt`/`lt`
  // silently drop those rows, and CSV export writes the literal string "NaN".
  it('returns null, not NaN, for a matched mesh that carries no vertices', () => {
    const geo = {
      meshes: [{ expressId: 7, positions: new Float32Array([]) } as GeometryResult['meshes'][number]],
      totalTriangles: 0,
      totalVertices: 0,
    } as GeometryResult;
    assert.equal(computeEntityLocalCenter(geo, 7), null);
  });

  // Kills the mutation "index by scanning per call". The getter must answer from
  // an index built once, so a lookup does not depend on the model's mesh count.
  // The functional half of that is pinned here; the cost half was measured
  // separately: 0.114 ms/call before, 0.0008 ms/call after, over 100k meshes.
  it('getWorldPosition indexes once at construction and never rescans on lookup', () => {
    // Instrumented rather than timed: count reads of `expressId`, which is the
    // only field a scan touches to find its target. Construction must read all
    // N once to build the index; a lookup must read none, because it resolves
    // through the Map and then touches only that entity's positions. A timing
    // assertion would be flaky; this states the property directly.
    let idReads = 0;
    // Every mesh gets a DISTINCT box, keyed off its index, so a byId mapping that
    // returns the wrong bucket produces the wrong coordinate instead of the right
    // one by coincidence. With one shared payload the assertions below hold for
    // any mesh the lookup happens to land on.
    const meshes = Array.from({ length: 5_000 }, (_, i) => {
      const mesh = {
        positions: new Float32Array([i, i, i, i + 2, i + 2, i + 2]),
      } as Record<string, unknown>;
      Object.defineProperty(mesh, 'expressId', { get() { idReads += 1; return i; }, enumerable: true });
      return mesh as unknown as GeometryResult['meshes'][number];
    });
    const geo = { meshes, totalTriangles: 0, totalVertices: 0 } as GeometryResult;
    const store = {
      source: new Uint8Array(),
      entityIndex: { byId: new Map(), byType: new Map() },
    } as unknown as Parameters<typeof makeWorldPositionGetter>[0];

    const get = makeWorldPositionGetter(store, geo, {}, (id) => id);
    assert.equal(idReads, 5_000, 'construction reads every expressId exactly once');

    idReads = 0;
    // Mesh 4999 spans [4999,5001] on each axis, so its local centre is 5000 and
    // the Z-up remap gives {x:5000, y:-5000, z:5000}. Any other bucket answers
    // with different numbers.
    const first = get(4_999);
    assert.deepEqual(first, { x: 5_000, y: -5_000, z: 5_000 });
    for (let i = 0; i < 100; i++) get(4_999);
    assert.deepEqual(get(4_999), first, 'repeated lookups agree');
    assert.equal(get(99_999), null, 'an id with no mesh answers null');
    assert.equal(idReads, 0, 'no lookup may rescan the mesh list');
  });

  it('returns null when the element has no matching mesh (not decoded / no geometry)', () => {
    const geo = fixture(5, [[0, 0, 0], [2, 2, 2]]);
    const frame: RenderFrameOffsets = { originShift: { x: 1, y: 1, z: 1 } };
    assert.equal(computeEntityWorldCenterZup(geo, 999, frame), null);
  });
});
