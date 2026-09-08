/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pull one entity's triangles out of a colour-merged `MeshData`.
 *
 * The colour-merge path packs many entities into a single mesh and tags each
 * VERTEX with its owner in `entityIds`, which is why such a mesh cannot be
 * split by the batch machinery (it is one indivisible piece as far as buffers
 * are concerned). Selection highlighting, per-entity raycast geometry and the
 * snap cache all need just the one entity, so they compact it out here.
 */

import type { MeshData } from '@ifc-lite/geometry';

/**
 * Extract only the vertices/triangles belonging to `targetId` from a
 * colour-merged MeshData that contains many entities. Returns a new
 * lightweight MeshData, or `undefined` when the target owns no whole triangle
 * in it.
 */
export function extractEntityFromMergedMesh(merged: MeshData, targetId: number): MeshData | undefined {
  const entityIds = merged.entityIds!;
  const positions = merged.positions;
  const normals = merged.normals;
  const indices = merged.indices;

  // Build a vertex mask and remap table
  const vertexCount = entityIds.length;
  const keep = new Uint8Array(vertexCount);
  let keptCount = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (entityIds[i] === targetId) { keep[i] = 1; keptCount++; }
  }
  if (keptCount === 0) return undefined;

  // Remap old vertex index → new compacted index
  const remap = new Uint32Array(vertexCount);
  let newIdx = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (keep[i]) { remap[i] = newIdx++; }
  }

  // Compact positions & normals
  const outPos = new Float32Array(keptCount * 3);
  const outNorm = new Float32Array(keptCount * 3);
  let outOff = 0;
  for (let i = 0; i < vertexCount; i++) {
    if (!keep[i]) continue;
    const src = i * 3;
    outPos[outOff] = positions[src];
    outPos[outOff + 1] = positions[src + 1];
    outPos[outOff + 2] = positions[src + 2];
    outNorm[outOff] = normals[src];
    outNorm[outOff + 1] = normals[src + 1];
    outNorm[outOff + 2] = normals[src + 2];
    outOff += 3;
  }

  // Compact indices (only triangles where ALL 3 vertices belong to target)
  const tmpIdx: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (keep[a] && keep[b] && keep[c]) {
      tmpIdx.push(remap[a], remap[b], remap[c]);
    }
  }
  if (tmpIdx.length === 0) return undefined;

  return {
    expressId: targetId,
    positions: outPos,
    normals: outNorm,
    indices: new Uint32Array(tmpIdx),
    color: merged.color,
    // Extracted vertices are copied verbatim from the merged mesh's local
    // frame, so carry its origin forward (world = origin + position) — else
    // raycast/highlight/snap would treat these local coords as world.
    origin: merged.origin,
  };
}
