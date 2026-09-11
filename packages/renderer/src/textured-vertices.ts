/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
/**
 * Interleave a textured mesh's vertices into the stride-36 layout
 * `[px,py,pz, nx,ny,nz, entityId(u32), u,v]`. Shared by initial upload and
 * the translate re-upload so the two can't drift. Returns null when the mesh
 * has no texture/uvs/geometry.
 */
export function interleaveTexturedVertices(
  meshData: MeshData,
): ArrayBuffer | null {
  const uvs = meshData.uvs;
  if (
    !(meshData.texture || (meshData.textureRef && meshData.textureBitmap)) ||
    !uvs
  )
    return null;
  const positions = meshData.positions;
  const normals = meshData.normals;
  const vertexCount = positions.length / 3;
  if (vertexCount === 0 || meshData.indices.length === 0) return null;

  const interleaved = new ArrayBuffer(vertexCount * 36);
  const f = new Float32Array(interleaved);
  const u = new Uint32Array(interleaved);
  const entityIds = meshData.entityIds;
  // Match mergeGeometry's entityId-lane packing so an overlay (lens/IDS/...)
  // drawn over a textured mesh computes the same z-nudge → depthCompare:'equal'
  // matches. High 8 bits = colour salt, low 24 = picking id.
  const saltByte = colorSaltByte(meshData.color);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 9;
    f[o] = positions[i * 3];
    f[o + 1] = positions[i * 3 + 1];
    f[o + 2] = positions[i * 3 + 2];
    f[o + 3] = normals[i * 3] ?? 0;
    f[o + 4] = normals[i * 3 + 1] ?? 0;
    f[o + 5] = normals[i * 3 + 2] ?? 0;
    u[o + 6] = packEntityLane(
      entityIds ? entityIds[i] : meshData.expressId,
      saltByte,
    );
    f[o + 7] = uvs[i * 2] ?? 0;
    f[o + 8] = uvs[i * 2 + 1] ?? 0;
  }
  return interleaved;
}
