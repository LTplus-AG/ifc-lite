/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Fixtures shared by the node and real-browser backing tests. */

import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';

/** A mesh exercising every field, with arrays viewing a larger shared arena. */
export function fullMesh(expressId: number, sourceIndices: Uint32Array, bitmap?: ImageBitmap): MeshData {
  const arena = new ArrayBuffer(4096);
  const positions = new Float32Array(arena, 64, 9);
  positions.set([0, 0, 0, 1.25, 0, 0, 0, 2.5, 0.000123]);
  const normals = new Float32Array(arena, 256, 9);
  normals.set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array(arena, 512, 3);
  indices.set([0, 1, 2]);
  return {
    expressId, ifcType: 'IfcWall', modelIndex: 2, positions, normals, indices,
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices, cornerIndices: new Uint32Array(0) },
    // f64 values a cache codec would narrow to f32.
    color: [0.1234567890123, 0.2, 0.3, 0.987654321], shadingColor: [0.5, 0.25, 0.125, 1],
    entityIds: Uint32Array.from([expressId, expressId + 1, expressId]),
    geometryItemId: 900 + expressId, material: { metallic: 0.25, roughness: 0.75 },
    uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
    texture: { rgba: Uint8Array.from([1, 2, 3, 4]), width: 1, height: 1, repeatS: true, repeatT: false },
    textureRef: { textureId: 77, url: 'brick.png', repeatS: true, repeatT: true },
    ...(bitmap ? { textureBitmap: bitmap } : {}),
    geometryHash: 0x1234_5678_9abc_def0n,
    geometryAabb: { min: [1, 2, 3], max: [4, 5, 6] }, geometryVolume: 1.5, geometryClass: 1,
    origin: [2_600_000.125, 12.5, -1_200_000.75], occurrenceKey: `${expressId}:k`,
    localBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    localToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10.5, 20.25, 30.125, 1],
  };
}

export function instancedShard(): DecodedInstancedShard {
  return {
    templates: [{
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2]), origin: [100.5, 0, -3],
    }],
    instances: [
      { templateIndex: 0, entityId: 501, color: [0.1, 0.2, 0.3, 1],
        transform: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]), itemId: 600 },
      { templateIndex: 0, entityId: 502, color: [0.4, 0.5, 0.6, 0.5],
        transform: Float32Array.from([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 8, 9, 10, 1]), metallic: 0, roughness: 0.3 },
    ],
    carriesItemIds: true, carriesFinishes: true,
  };
}

/** Every observable field, with identity relations expressed as booleans. */
export function describeMesh(mesh: MeshData): Record<string, unknown> {
  const arrays = Object.fromEntries((['positions', 'normals', 'indices', 'entityIds', 'uvs'] as const)
    .map((key) => [key, mesh[key] ? { type: mesh[key].constructor.name, values: [...mesh[key]] } : undefined]));
  const { appearanceSource: source, texture, textureBitmap, ...rest } = mesh;
  const scalars = Object.fromEntries(Object.entries(rest).filter(([key]) => !(key in arrays)));
  return {
    ...scalars, ...arrays,
    texture: texture ? { ...texture, rgba: [...texture.rgba] } : undefined,
    hasBitmap: textureBitmap !== undefined,
    appearance: source ? {
      fenceIsIndices: source.indices === mesh.indices,
      fence: [...source.indices], sourceIndices: [...source.sourceIndices],
      cornerIndices: source.cornerIndices ? [...source.cornerIndices] : 'absent',
    } : undefined,
  };
}
