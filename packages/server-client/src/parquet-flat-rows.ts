/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The flat Parquet layout's columns and its per-row reconstruction, shared by
 * `buildMeshesFromTables` (every row its own mesh) and the shared-shape decode
 * (`parquet-shared-shapes.ts`), which keeps rows naming one vertex block as
 * occurrences of one shape instead of copying the block per row.
 */

import type { MeshData } from './types.js';
import { meshColumns, numericColumn, transformFields } from './parquet-columns.js';
import { applyInstanceRotation, readRotationColumns } from './parquet-rotation.js';
import type { ArrowTableLike } from './parquet-tables.js';

/** The flat layout's columns, present, parallel and resolved once per table set. */
export type FlatColumns = ReturnType<typeof readFlatColumns>;

/** Resolve and validate every column the flat layout reads; throws on a structurally malformed table. */
export function readFlatColumns(
  meshArrow: ArrowTableLike,
  vertexArrow: ArrowTableLike,
  indexArrow: ArrowTableLike
) {
  // Extract columns from mesh table
  const expressIds = numericColumn(meshArrow, 'express_id');
  const ifcTypes = meshArrow.getChild('ifc_type');
  const vertexStarts = numericColumn(meshArrow, 'vertex_start');
  const vertexCounts = numericColumn(meshArrow, 'vertex_count');
  const indexStarts = numericColumn(meshArrow, 'index_start');
  const indexCounts = numericColumn(meshArrow, 'index_count');
  const colorR = numericColumn(meshArrow, 'color_r');
  const colorG = numericColumn(meshArrow, 'color_g');
  const colorB = numericColumn(meshArrow, 'color_b');
  const colorA = numericColumn(meshArrow, 'color_a');
  if (!expressIds || !vertexStarts || !vertexCounts || !indexStarts || !indexCounts) {
    throw new Error('Malformed Parquet geometry: missing required mesh column');
  }
  if (!colorR || !colorG || !colorB || !colorA) {
    throw new Error('Malformed Parquet geometry: missing required color column');
  }

  // Extract columns from vertex table
  const posX = numericColumn(vertexArrow, 'x');
  const posY = numericColumn(vertexArrow, 'y');
  const posZ = numericColumn(vertexArrow, 'z');
  const normX = numericColumn(vertexArrow, 'nx');
  const normY = numericColumn(vertexArrow, 'ny');
  const normZ = numericColumn(vertexArrow, 'nz');

  // Extract columns from index table
  const idx0 = numericColumn(indexArrow, 'i0');
  const idx1 = numericColumn(indexArrow, 'i1');
  const idx2 = numericColumn(indexArrow, 'i2');

  // The per-mesh bounds check below only validates posX/normX/idx0, but the
  // loop also reads the sibling columns (posY/posZ, normY/normZ, idx1/idx2).
  // A malformed payload with a missing or short sibling would read `undefined`
  // → NaN positions / bad indices, so verify presence + matching lengths once
  // up front; the per-mesh check then transitively covers every sibling.
  if (!posX || !posY || !posZ || !normX || !normY || !normZ || !idx0 || !idx1 || !idx2) {
    throw new Error('Malformed Parquet geometry: missing required vertex/index column');
  }
  if (
    posX.length !== posY.length ||
    posX.length !== posZ.length ||
    normX.length !== normY.length ||
    normX.length !== normZ.length ||
    idx0.length !== idx1.length ||
    idx0.length !== idx2.length
  ) {
    throw new Error('Malformed Parquet geometry: inconsistent parallel column lengths');
  }

  const meshCount = expressIds.length;
  return {
    meshCount, expressIds, ifcTypes, vertexStarts, vertexCounts, indexStarts, indexCounts,
    colorR, colorG, colorB, colorA, posX, posY, posZ, normX, normY, normZ, idx0, idx1, idx2,
    // Additive per-mesh columns (#1841, #3215) — absent on payloads and caches
    // from servers predating them, where origin defaults to [0,0,0] and the
    // source ids simply do not appear. Only consumed when all three origin
    // components are present AND parallel to the mesh rows — a short or
    // partial set (malformed/truncated payload) must not read `undefined` → NaN.
    extra: meshColumns(meshArrow, meshCount),
    // Absent on every pre-#3888 payload. The flat transport has no version byte
    // to tell a truncated v6 from a genuine v5, so absence reads as the identity
    // it is on a v5 blob (see `readRotationColumns`).
    rotation: readRotationColumns(meshArrow, meshCount, 'identity'),
  };
}

/**
 * Validate row `i`'s vertex and index ranges against the actual (untrusted)
 * column lengths before indexing, so an overrun fails loudly instead of
 * silently writing NaN positions / 0 indices into the geometry.
 */
export function checkFlatRange(c: FlatColumns, i: number): void {
  const vertexStart = c.vertexStarts[i];
  const vertexCount = c.vertexCounts[i];
  const indexStart = c.indexStarts[i];
  const indexCount = c.indexCounts[i];
  if (
    vertexStart + vertexCount > c.posX.length ||
    vertexStart + vertexCount > c.normX.length ||
    indexStart % 3 !== 0 ||
    indexCount % 3 !== 0 ||
    (indexStart + indexCount) / 3 > c.idx0.length
  ) {
    throw new Error(
      `Malformed Parquet geometry: mesh ${i} range out of bounds ` +
        `(vertexStart=${vertexStart}, vertexCount=${vertexCount}, vertices=${c.posX.length}; ` +
        `indexStart=${indexStart}, indexCount=${indexCount}, triangles=${c.idx0.length})`
    );
  }
}

/** Copy row `i`'s vertex block and triangle indices out of the columns, unrotated and without its origin. */
export function readFlatBlock(c: FlatColumns, i: number): { positions: Float32Array; normals: Float32Array; indices: Uint32Array } {
  checkFlatRange(c, i);
  const vertexStart = c.vertexStarts[i];
  const vertexCount = c.vertexCounts[i];
  // Reconstruct interleaved positions and normals from columnar format. The
  // server already applies the Z-up -> Y-up swap, so this just copies through.
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const srcIdx = vertexStart + v;
    positions[v * 3] = c.posX[srcIdx];
    positions[v * 3 + 1] = c.posY[srcIdx];
    positions[v * 3 + 2] = c.posZ[srcIdx];
    normals[v * 3] = c.normX[srcIdx];
    normals[v * 3 + 1] = c.normY[srcIdx];
    normals[v * 3 + 2] = c.normZ[srcIdx];
  }
  // Reconstruct triangle indices from columnar format.
  const indexCount = c.indexCounts[i];
  const triangleCount = indexCount / 3, triangleStart = c.indexStarts[i] / 3;
  const indices = new Uint32Array(indexCount);
  for (let t = 0; t < triangleCount; t++) {
    const srcIdx = triangleStart + t;
    indices[t * 3] = c.idx0[srcIdx];
    indices[t * 3 + 1] = c.idx1[srcIdx];
    indices[t * 3 + 2] = c.idx2[srcIdx];
  }
  return { positions, normals, indices };
}

/** Row `i` as its own mesh: its block copied out, rotated onto the row and stamped with its fields. */
export function buildFlatMesh(c: FlatColumns, i: number): MeshData {
  const { positions, normals, indices } = readFlatBlock(c, i);
  // Rotate the shared block onto THIS occurrence before `origin` translates
  // it (`world = origin + R * p`). A no-op on an identity row, which is every
  // row of a v5 payload and every unshared row of a v6 one.
  if (c.rotation) applyInstanceRotation(positions, normals, c.rotation, i);
  return {
    express_id: c.expressIds[i],
    ifc_type: (c.ifcTypes?.get(i) as string) ?? 'Unknown',
    positions,
    normals,
    indices,
    color: [c.colorR[i], c.colorG[i], c.colorB[i], c.colorA[i]],
    // world vertex = origin + position (both Y-up metres).
    ...transformFields(i, c.extra),
  };
}
