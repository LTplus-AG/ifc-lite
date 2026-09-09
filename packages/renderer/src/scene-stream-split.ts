/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';

/** Split geometry without losing texture resources or changing vertex-lane correspondence. */
export function splitMeshForStreaming(meshData: MeshData, maxIndices: number, maxVertexBytes: number): MeshData[] {
  const vertexBytes = meshData.positions.byteLength + meshData.normals.byteLength;
  if (
    meshData.indices.length <= maxIndices &&
    vertexBytes <= maxVertexBytes
  ) {
    return [meshData];
  }

  const maxIndexCount = Math.max(3, Math.floor(maxIndices / 3) * 3);
  const fragments: MeshData[] = [];
  const candidate = meshData.appearanceSource;
  const source = candidate?.indices === meshData.indices &&
    (!candidate.cornerIndices || candidate.cornerIndices.length === meshData.indices.length)
    ? candidate : undefined;

  for (let start = 0; start < meshData.indices.length; start += maxIndexCount) {
    const end = Math.min(start + maxIndexCount, meshData.indices.length);
    const sourceIndices = meshData.indices.subarray(start, end);
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const entityIds: number[] = [];
    const indices = new Uint32Array(sourceIndices.length);

    for (let i = 0; i < sourceIndices.length; i++) {
      const sourceIndex = sourceIndices[i];
      let nextIndex = remap.get(sourceIndex);
      if (nextIndex === undefined) {
        nextIndex = remap.size;
        remap.set(sourceIndex, nextIndex);
        if (meshData.uvs) uvs.push(meshData.uvs[sourceIndex * 2], meshData.uvs[sourceIndex * 2 + 1]);
        if (meshData.entityIds) entityIds.push(meshData.entityIds[sourceIndex]);
        const base = sourceIndex * 3;
        positions.push(
          meshData.positions[base],
          meshData.positions[base + 1],
          meshData.positions[base + 2]
        );
        normals.push(
          meshData.normals[base],
          meshData.normals[base + 1],
          meshData.normals[base + 2]
        );
      }
      indices[i] = nextIndex;
    }

    fragments.push({
      // Keep shared texture resources and the parent local frame/bounds (#4228).
      ...meshData,
      ...(meshData.uvs ? { uvs: new Float32Array(uvs) } : {}),
      ...(meshData.entityIds ? { entityIds: new Uint32Array(entityIds) } : {}),
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices,
      ...(candidate ? { appearanceSource: source ? {
        ...source, indices, cornerIndices: Uint32Array.from(sourceIndices, (_, index) => source.cornerIndices?.[start + index] ?? start + index),
      } : undefined } : {}),
    });
  }

  return fragments;
}
