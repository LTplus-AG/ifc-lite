/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../hooks/useBCF.js';
import { withInstancedMeshes } from './instancedExport.js';

function mesh(expressId: number, verts: number, tris: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array(verts * 3),
    normals: new Float32Array(verts * 3),
    indices: new Uint32Array(tris * 3),
    color: [1, 1, 1, 1],
  };
}

function baseGeometry(): GeometryResult {
  return {
    meshes: [mesh(1, 3, 1)],
    totalTriangles: 1,
    totalVertices: 3,
    // coordinateInfo is irrelevant to this helper.
    coordinateInfo: {} as GeometryResult['coordinateInfo'],
  };
}

/** Install a fake global renderer whose scene returns `instanced` (or no scene
 *  when `instanced` is null). */
function setRenderer(instanced: MeshData[] | null): void {
  const scene = instanced === null ? undefined : { getAllInstancedMeshData: () => instanced };
  const fake = { getScene: () => scene } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

describe('withInstancedMeshes', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  // CALIBRATION (#2865/#2878 follow-up): proves the id-range filter actually
  // excludes another loaded model's instanced occurrences — not that the gate
  // was simply removed. `mesh(2, ...)`'s global id (2) falls OUTSIDE this
  // model's declared bracket (idOffset 100, so ids 101..150), the way a
  // DIFFERENT federated model's occurrence would.
  it('excludes an instanced occurrence outside this model\'s id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 3, 1)]);
    assert.equal(withInstancedMeshes(geom, { idOffset: 100, maxExpressId: 50 }), geom);
  });

  // The federated-gap counterpart: an occurrence INSIDE this model's own
  // bracket IS adopted — the id-range filter is a scope, not a second
  // primary-only gate in disguise.
  it('appends an instanced occurrence inside this model\'s id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(107, 4, 2)]);
    const out = withInstancedMeshes(geom, { idOffset: 100, maxExpressId: 50 });
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 107]);
  });

  it('returns the geometryResult unchanged when the scene has no instanced meshes', () => {
    const geom = baseGeometry();
    setRenderer([]);
    assert.equal(withInstancedMeshes(geom, null), geom);
  });

  it('appends instanced occurrences and recomputes totals, unfiltered when modelRange is null', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 4, 2), mesh(3, 5, 3)]);
    const out = withInstancedMeshes(geom, null);

    assert.notEqual(out, geom); // a copy, not mutated in place
    assert.equal(geom.meshes.length, 1); // original untouched
    assert.equal(out.meshes.length, 3);
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 2, 3]);
    // 1 (base) + 2 + 3 instanced triangles; 3 + 4 + 5 vertices.
    assert.equal(out.totalTriangles, 6);
    assert.equal(out.totalVertices, 12);
  });

  it('appends instanced occurrences and recomputes totals, filtered to a model-id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 4, 2), mesh(3, 5, 3)]);
    const out = withInstancedMeshes(geom, { idOffset: 0, maxExpressId: 10 });

    assert.notEqual(out, geom); // a copy, not mutated in place
    assert.equal(geom.meshes.length, 1); // original untouched
    assert.equal(out.meshes.length, 3);
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 2, 3]);
    // 1 (base) + 2 + 3 instanced triangles; 3 + 4 + 5 vertices.
    assert.equal(out.totalTriangles, 6);
    assert.equal(out.totalVertices, 12);
  });

  it('is a no-op when the renderer scene is unavailable', () => {
    const geom = baseGeometry();
    setRenderer(null);
    assert.equal(withInstancedMeshes(geom, null), geom);
  });
});
