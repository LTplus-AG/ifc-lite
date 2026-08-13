/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #2558: the Cesium world view rendered a georeferenced tower as bare
 * floor slabs — the entire curtain-wall facade was missing — while the WebGPU
 * viewport drew it correctly. Cause: the GLB was built from
 * `geometryResult.meshes`, which by design excludes every GPU-instanced
 * occurrence (9,950 of 18,555 meshes on the reported model).
 *
 * These assert the world-view GLB is built from the COMPLETE model. Reverting
 * `buildCesiumModelGLB` to `buildMergedGLB(geometryResult.meshes)` fails the
 * vertex-count and triangle-count assertions below.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../../hooks/useBCF.js';
import { buildCesiumModelGLB, cesiumModelGLBKey } from './cesium-model-glb.js';

/** One triangle at x = `x`, so a mesh's vertices are identifiable in the GLB. */
function mesh(expressId: number, x: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcCurtainWall',
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.2, 0.2, 0.2, 1],
  } as unknown as MeshData;
}

function geometry(meshes: MeshData[]): GeometryResult {
  return {
    meshes,
    totalTriangles: meshes.length,
    totalVertices: meshes.length * 3,
    coordinateInfo: {} as GeometryResult['coordinateInfo'],
  } as GeometryResult;
}

/** Install a fake global renderer whose scene reports `instanced` occurrences. */
function setRenderer(instanced: MeshData[] | null): void {
  const scene = instanced === null
    ? undefined
    : {
        getAllInstancedMeshData: () => instanced,
        // Distinct entity ids, mirroring `instancedEntityMap.size`.
        getInstancedEntityCount: () => new Set(instanced.map((m) => m.expressId)).size,
      };
  const fake = { getScene: () => scene } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

/** Parse the GLB container → its glTF JSON. */
function parseGlb(glb: Uint8Array): { accessors: Array<{ count: number; type: string }> } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'GLB magic');
  const jsonLen = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
}

/** POSITION accessor count = vertices actually packed into the GLB. */
function glbVertexCount(glb: Uint8Array): number {
  return parseGlb(glb).accessors[0].count;
}

/** SCALAR index accessor count / 3 = triangles actually packed into the GLB. */
function glbTriangleCount(glb: Uint8Array): number {
  const accessors = parseGlb(glb).accessors;
  const indices = accessors.find((a) => a.type === 'SCALAR');
  assert.ok(indices, 'GLB has an index accessor');
  return indices.count / 3;
}

describe('buildCesiumModelGLB (#2558 world view drops instanced geometry)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('packs the GPU-instanced occurrences the flat mesh list omits', () => {
    // 1 flat mesh, 3 instanced occurrences — the facade-panel shape of #2558.
    setRenderer([mesh(2, 10), mesh(3, 20), mesh(4, 30)]);

    const { glb } = buildCesiumModelGLB(geometry([mesh(1, 0)]), 0);

    assert.equal(glbVertexCount(glb), 12, '3 verts x (1 flat + 3 instanced) meshes');
    assert.equal(glbTriangleCount(glb), 4, '1 flat + 3 instanced triangles');
  });

  it('still builds the flat model when the scene has no instanced geometry', () => {
    setRenderer([]);

    const { glb } = buildCesiumModelGLB(geometry([mesh(1, 0), mesh(2, 10)]), 0);

    assert.equal(glbVertexCount(glb), 6);
    assert.equal(glbTriangleCount(glb), 2);
  });

  it('builds the flat model when no renderer is available', () => {
    setRenderer(null);

    const { glb } = buildCesiumModelGLB(geometry([mesh(1, 0)]), 0);

    assert.equal(glbVertexCount(glb), 3);
  });

  it('does not mutate the caller\'s geometryResult', () => {
    setRenderer([mesh(2, 10)]);
    const geom = geometry([mesh(1, 0)]);

    buildCesiumModelGLB(geom, 0);

    assert.equal(geom.meshes.length, 1, 'instanced meshes are not appended in place');
  });
});

describe('cesiumModelGLBKey (#2558 cache key)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('changes when an all-instanced batch lands, which the flat count cannot see', () => {
    const geom = geometry([mesh(1, 0)]);

    setRenderer([]);
    const before = cesiumModelGLBKey(geom, 0);
    // A batch whose occurrences are ALL instanced: same flat mesh list, more
    // geometry. Keying on `meshes.length` alone would serve a stale GLB.
    setRenderer([mesh(2, 10), mesh(3, 20)]);
    const after = cesiumModelGLBKey(geom, 0);

    assert.notEqual(after, before);
  });

  it('is stable while nothing changes, so the cached GLB is reused', () => {
    setRenderer([mesh(2, 10)]);
    const geom = geometry([mesh(1, 0)]);

    assert.equal(cesiumModelGLBKey(geom, 0), cesiumModelGLBKey(geom, 0));
  });

  it('changes on an in-place edit, which moves no count at all', () => {
    setRenderer([mesh(2, 10)]);
    // A gizmo move rewrites positions in the SAME arrays: same flat mesh count,
    // same instanced entity count, different geometry. Only the store's
    // content-version counter can see it.
    const geom = geometry([mesh(1, 0)]);

    assert.notEqual(cesiumModelGLBKey(geom, 1), cesiumModelGLBKey(geom, 0));
  });

  it('matches the key the builder stamps onto the bytes it returns', () => {
    setRenderer([mesh(2, 10)]);
    const geom = geometry([mesh(1, 0)]);

    assert.equal(buildCesiumModelGLB(geom, 0).key, cesiumModelGLBKey(geom, 0));
  });
});
