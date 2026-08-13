/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two shipped bugs are pinned here.
 *
 * #2558: the Cesium world view rendered a georeferenced tower as bare floor
 * slabs — the whole curtain-wall facade missing — because the GLB was built
 * from `geometryResult.meshes`, which by design excludes every GPU-instanced
 * occurrence (9,950 of 18,555 meshes on the reported model).
 *
 * #2578: the world view then drew elements the user had hidden or isolated
 * away, because it renders through its own glTF pipeline and never received
 * the hide/isolate sets the renderer filters with every frame.
 *
 * Reverting either half fails here: dropping `withInstancedMeshes` fails the
 * vertex/triangle counts, and dropping the visibility filter fails the
 * hide/isolate cases.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../../hooks/useBCF.js';
import {
  buildCesiumModelGLB,
  cesiumModelGLBKey,
  type CesiumModelGLBInput,
} from './cesium-model-glb.js';

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

/** Default input: no in-place edits, nothing hidden, nothing isolated. */
function input(
  meshes: MeshData[],
  over: Partial<CesiumModelGLBInput> = {},
): CesiumModelGLBInput {
  return {
    geometryResult: geometry(meshes),
    geometryContentVersion: 0,
    hiddenIds: null,
    isolatedIds: null,
    visibilityVersion: 0,
    ...over,
  };
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
  return parseGlb(glb).accessors[0]?.count ?? 0;
}

/** SCALAR index accessor count / 3 = triangles actually packed into the GLB. */
function glbTriangleCount(glb: Uint8Array): number {
  const indices = parseGlb(glb).accessors.find((a) => a.type === 'SCALAR');
  return indices ? indices.count / 3 : 0;
}

describe('buildCesiumModelGLB — completeness (#2558)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('packs the GPU-instanced occurrences the flat mesh list omits', () => {
    // 1 flat mesh, 3 instanced occurrences — the facade-panel shape of #2558.
    setRenderer([mesh(2, 10), mesh(3, 20), mesh(4, 30)]);

    const { glb } = buildCesiumModelGLB(input([mesh(1, 0)]));

    assert.equal(glbVertexCount(glb), 12, '3 verts x (1 flat + 3 instanced) meshes');
    assert.equal(glbTriangleCount(glb), 4, '1 flat + 3 instanced triangles');
  });

  it('still builds the flat model when the scene has no instanced geometry', () => {
    setRenderer([]);

    const { glb } = buildCesiumModelGLB(input([mesh(1, 0), mesh(2, 10)]));

    assert.equal(glbVertexCount(glb), 6);
    assert.equal(glbTriangleCount(glb), 2);
  });

  it('builds the flat model when no renderer is available', () => {
    setRenderer(null);

    const { glb } = buildCesiumModelGLB(input([mesh(1, 0)]));

    assert.equal(glbVertexCount(glb), 3);
  });

  it("does not mutate the caller's geometryResult", () => {
    setRenderer([mesh(2, 10)]);
    const inp = input([mesh(1, 0)]);

    buildCesiumModelGLB(inp);

    assert.equal(inp.geometryResult.meshes.length, 1, 'instanced meshes are not appended in place');
  });
});

describe('buildCesiumModelGLB — hide/isolate parity with the viewport (#2578)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('drops a hidden flat mesh', () => {
    setRenderer([]);

    const { glb } = buildCesiumModelGLB(
      input([mesh(1, 0), mesh(2, 10)], { hiddenIds: new Set([2]) }),
    );

    assert.equal(glbTriangleCount(glb), 1, 'only the visible flat mesh survives');
  });

  it('drops a hidden INSTANCED occurrence — the half a flat-only filter would miss', () => {
    setRenderer([mesh(2, 10), mesh(3, 20)]);

    const { glb } = buildCesiumModelGLB(
      input([mesh(1, 0)], { hiddenIds: new Set([3]) }),
    );

    assert.equal(glbTriangleCount(glb), 2, '1 flat + 1 surviving instanced occurrence');
  });

  it('keeps only isolated ids, across both halves', () => {
    setRenderer([mesh(2, 10), mesh(3, 20)]);

    const { glb } = buildCesiumModelGLB(
      input([mesh(1, 0)], { isolatedIds: new Set([1, 3]) }),
    );

    assert.equal(glbTriangleCount(glb), 2, 'the flat mesh and the isolated occurrence');
  });

  it('treats an EMPTY isolated set as isolating nothing, not as no filter', () => {
    setRenderer([mesh(2, 10)]);

    const { glb } = buildCesiumModelGLB(
      input([mesh(1, 0)], { isolatedIds: new Set() }),
    );

    assert.equal(glbTriangleCount(glb), 0, 'an empty isolation set hides everything');
  });

  it('lets hiding win over isolation, as the renderer does', () => {
    setRenderer([]);

    const { glb } = buildCesiumModelGLB(
      input([mesh(1, 0)], { hiddenIds: new Set([1]), isolatedIds: new Set([1]) }),
    );

    assert.equal(glbTriangleCount(glb), 0);
  });

  it('draws everything when neither filter is active', () => {
    setRenderer([mesh(2, 10)]);

    const { glb } = buildCesiumModelGLB(input([mesh(1, 0)]));

    assert.equal(glbTriangleCount(glb), 2);
  });
});

describe('cesiumModelGLBKey', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('changes when an all-instanced batch lands, which the flat count cannot see', () => {
    setRenderer([]);
    const before = cesiumModelGLBKey(input([mesh(1, 0)]));
    // A batch whose occurrences are ALL instanced: same flat mesh list, more
    // geometry. Keying on `meshes.length` alone would serve a stale GLB.
    setRenderer([mesh(2, 10), mesh(3, 20)]);

    assert.notEqual(cesiumModelGLBKey(input([mesh(1, 0)])), before);
  });

  it('changes on an in-place edit, which moves no count at all', () => {
    setRenderer([mesh(2, 10)]);

    assert.notEqual(
      cesiumModelGLBKey(input([mesh(1, 0)], { geometryContentVersion: 1 })),
      cesiumModelGLBKey(input([mesh(1, 0)])),
    );
  });

  it('changes when visibility changes, which moves no count either', () => {
    setRenderer([mesh(2, 10)]);

    assert.notEqual(
      cesiumModelGLBKey(input([mesh(1, 0)], { visibilityVersion: 1 })),
      cesiumModelGLBKey(input([mesh(1, 0)])),
    );
  });

  it('is stable while nothing changes, so the cached GLB is reused', () => {
    setRenderer([mesh(2, 10)]);

    assert.equal(cesiumModelGLBKey(input([mesh(1, 0)])), cesiumModelGLBKey(input([mesh(1, 0)])));
  });

  it('matches the key the builder stamps onto the bytes it returns', () => {
    setRenderer([mesh(2, 10)]);
    const inp = input([mesh(1, 0)]);

    assert.equal(buildCesiumModelGLB(inp).key, cesiumModelGLBKey(inp));
  });
});
