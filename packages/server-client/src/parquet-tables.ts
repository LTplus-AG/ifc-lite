// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Arrow table -> MeshData reconstruction (the pure half of the Parquet decoder).
 *
 * Split out of `parquet-decoder.ts` so the column contract can be tested without
 * booting parquet-wasm: `parquet-decoder.ts` keeps the wire framing and the WASM
 * reader, this file keeps the part that decides what each column MEANS.
 *
 * That distinction is the whole of issue #1841 — the decoder silently dropped
 * `origin` / `geometry_class`, and nothing failed because no test could reach
 * this logic. See `parquet-tables.test.ts`.
 */

import type { MeshData } from './types.js';

/**
 * Structural view of the bits of `apache-arrow`'s `Table` this module uses.
 * Deliberately minimal: it keeps the real Arrow types out of the signature
 * (their browser export map hides the `.d.ts` from TS's strict resolver) and it
 * lets tests pass plain objects.
 */
export interface ArrowColumnLike {
  toArray(): ArrayLike<number>;
  get(index: number): unknown;
}

export interface ArrowTableLike {
  getChild(name: string): ArrowColumnLike | null | undefined;
}

/** Read a numeric column, or `undefined` when the table does not carry it. */
function numericColumn(table: ArrowTableLike, name: string): ArrayLike<number> | undefined {
  return table.getChild(name)?.toArray();
}

/**
 * True when all three origin components are present AND parallel to `rowCount`.
 *
 * A short or partial set (truncated payload, or a server predating the columns)
 * must fall back to "no origin" rather than index past the end into `undefined`
 * -> NaN. Shared by both decoders so the standard and instanced paths can never
 * disagree about when the origin is trustworthy.
 */
function originIsUsable(
  x: ArrayLike<number> | undefined,
  y: ArrayLike<number> | undefined,
  z: ArrayLike<number> | undefined,
  rowCount: number
): boolean {
  return (
    !!x && !!y && !!z && x.length === rowCount && y.length === rowCount && z.length === rowCount
  );
}

/**
 * The canonical per-mesh transform metadata, spread into the `MeshData` literal.
 *
 * `origin` is omitted when the frame IS the world origin and `geometry_class`
 * when it is 0 (occurrence), so a world-baked mesh decodes to exactly the shape
 * it had before these columns existed — and to the same shape on every
 * transport (JSON, standard Parquet, optimized Parquet).
 */
function transformFields(
  index: number,
  originX: ArrayLike<number> | undefined,
  originY: ArrayLike<number> | undefined,
  originZ: ArrayLike<number> | undefined,
  hasOrigin: boolean,
  geometryClass: ArrayLike<number> | undefined,
  hasGeometryClass: boolean
): Partial<MeshData> {
  const origin =
    hasOrigin && (originX![index] || originY![index] || originZ![index])
      ? ([originX![index], originY![index], originZ![index]] as [number, number, number])
      : undefined;
  const geometry_class =
    hasGeometryClass && geometryClass![index] ? geometryClass![index] : undefined;

  return {
    ...(origin ? { origin } : {}),
    ...(geometry_class ? { geometry_class } : {}),
  };
}

/**
 * Rebuild `MeshData[]` from the standard (non-instanced) three-table layout.
 *
 * Positions/normals are already Y-up metres — the server applies the axis swap
 * once, in `services::axis` (issue #1841), so every transport agrees.
 */
export function buildMeshesFromTables(
  meshArrow: ArrowTableLike,
  vertexArrow: ArrowTableLike,
  indexArrow: ArrowTableLike
): MeshData[] {
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
  // Per-mesh local-frame origin + geometry provenance (issue #1841). Additive
  // columns — absent on payloads/caches from servers predating this field, in
  // which case origin defaults to [0,0,0] (world-baked, the prior behaviour).
  const originX = numericColumn(meshArrow, 'origin_x');
  const originY = numericColumn(meshArrow, 'origin_y');
  const originZ = numericColumn(meshArrow, 'origin_z');
  const geometryClass = numericColumn(meshArrow, 'geometry_class');

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

  // Reconstruct MeshData array
  const meshCount = expressIds.length;
  const meshes: MeshData[] = new Array(meshCount);

  // Only consume the additive origin/geometry_class columns when all three
  // origin components are present AND parallel to the mesh rows — a short or
  // partial set (malformed/truncated payload) must not read `undefined` → NaN.
  const hasOrigin = originIsUsable(originX, originY, originZ, meshCount);
  const hasGeometryClass = !!geometryClass && geometryClass.length === meshCount;

  for (let i = 0; i < meshCount; i++) {
    const vertexStart = vertexStarts[i];
    const vertexCount = vertexCounts[i];
    const indexStart = indexStarts[i];
    const indexCount = indexCounts[i];

    // Validate per-mesh ranges against the actual (untrusted) column lengths
    // before indexing, so an overrun fails loudly instead of silently
    // writing NaN positions / 0 indices into the geometry.
    if (
      vertexStart + vertexCount > posX.length ||
      vertexStart + vertexCount > normX.length ||
      indexStart % 3 !== 0 ||
      indexCount % 3 !== 0 ||
      (indexStart + indexCount) / 3 > idx0.length
    ) {
      throw new Error(
        `Malformed Parquet geometry: mesh ${i} range out of bounds ` +
          `(vertexStart=${vertexStart}, vertexCount=${vertexCount}, vertices=${posX.length}; ` +
          `indexStart=${indexStart}, indexCount=${indexCount}, triangles=${idx0.length})`
      );
    }

    // Reconstruct interleaved positions from columnar format
    // OPTIMIZATION: Z-up to Y-up transform is now done server-side
    // Server already transforms: X stays same, new Y = old Z, new Z = -old Y
    // So we just copy directly without per-vertex transformation
    const positions = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const srcIdx = vertexStart + v;
      positions[v * 3] = posX[srcIdx];
      positions[v * 3 + 1] = posY[srcIdx];
      positions[v * 3 + 2] = posZ[srcIdx];
    }

    // Reconstruct interleaved normals (also pre-transformed server-side)
    const normals = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const srcIdx = vertexStart + v;
      normals[v * 3] = normX[srcIdx];
      normals[v * 3 + 1] = normY[srcIdx];
      normals[v * 3 + 2] = normZ[srcIdx];
    }

    // Reconstruct triangle indices from columnar format
    const triangleCount = indexCount / 3;
    const triangleStart = indexStart / 3;
    const indices = new Uint32Array(indexCount);
    for (let t = 0; t < triangleCount; t++) {
      const srcIdx = triangleStart + t;
      indices[t * 3] = idx0[srcIdx];
      indices[t * 3 + 1] = idx1[srcIdx];
      indices[t * 3 + 2] = idx2[srcIdx];
    }

    meshes[i] = {
      express_id: expressIds[i],
      ifc_type: (ifcTypes?.get(i) as string) ?? 'Unknown',
      positions,
      normals,
      indices,
      color: [colorR[i], colorG[i], colorB[i], colorA[i]],
      // world vertex = origin + position (both Y-up metres).
      ...transformFields(
        i,
        originX,
        originY,
        originZ,
        hasOrigin,
        geometryClass,
        hasGeometryClass
      ),
    };
  }

  return meshes;
}

/** Tables + header flags of the optimized (instanced, quantized) layout. */
export interface OptimizedTables {
  instanceArrow: ArrowTableLike;
  meshArrow: ArrowTableLike;
  materialArrow: ArrowTableLike;
  vertexArrow: ArrowTableLike;
  indexArrow: ArrowTableLike;
  /** From the payload header flags: whether the vertex table carries normals. */
  hasNormals: boolean;
  /** Quantization divisor: metres = quantized / vertexMultiplier. */
  vertexMultiplier: number;
}

/**
 * Rebuild `MeshData[]` from the optimized instanced layout.
 *
 * Geometry is deduplicated: many instances share one template mesh, so the
 * per-INSTANCE `origin` is the only thing that places each occurrence. Dropping
 * it renders every occurrence at the template's coordinates — literally the
 * "N slabs collapse to one" symptom of issue #1841.
 */
export function buildMeshesFromOptimizedTables(tables: OptimizedTables): MeshData[] {
  const {
    instanceArrow,
    meshArrow,
    materialArrow,
    vertexArrow,
    indexArrow,
    hasNormals,
    vertexMultiplier,
  } = tables;

  // Extract instance columns
  const entityIds = numericColumn(instanceArrow, 'entity_id');
  const ifcTypes = instanceArrow.getChild('ifc_type');
  const meshIndices = numericColumn(instanceArrow, 'mesh_index');
  const materialIndices = numericColumn(instanceArrow, 'material_index');
  // Per-instance placement + provenance (issue #1841). Additive columns —
  // absent on payloads from servers predating them, where origin defaults to
  // [0,0,0].
  const instOriginX = numericColumn(instanceArrow, 'origin_x');
  const instOriginY = numericColumn(instanceArrow, 'origin_y');
  const instOriginZ = numericColumn(instanceArrow, 'origin_z');
  const instGeometryClass = numericColumn(instanceArrow, 'geometry_class');

  // Extract mesh columns
  const meshVertexOffsets = numericColumn(meshArrow, 'vertex_offset');
  const meshVertexCounts = numericColumn(meshArrow, 'vertex_count');
  const meshIndexOffsets = numericColumn(meshArrow, 'index_offset');
  const meshIndexCounts = numericColumn(meshArrow, 'index_count');

  // Extract material columns (bytes 0-255)
  const matR = numericColumn(materialArrow, 'r');
  const matG = numericColumn(materialArrow, 'g');
  const matB = numericColumn(materialArrow, 'b');
  const matA = numericColumn(materialArrow, 'a');

  // Extract vertex columns (quantized integers)
  const vertexX = numericColumn(vertexArrow, 'x');
  const vertexY = numericColumn(vertexArrow, 'y');
  const vertexZ = numericColumn(vertexArrow, 'z');
  const normalX = hasNormals ? numericColumn(vertexArrow, 'nx') : undefined;
  const normalY = hasNormals ? numericColumn(vertexArrow, 'ny') : undefined;
  const normalZ = hasNormals ? numericColumn(vertexArrow, 'nz') : undefined;

  // Extract index column
  const indices = numericColumn(indexArrow, 'i');

  if (!entityIds || !meshIndices || !materialIndices) {
    throw new Error('Malformed optimized Parquet geometry: missing required instance column');
  }
  if (!meshVertexOffsets || !meshVertexCounts || !meshIndexOffsets || !meshIndexCounts) {
    throw new Error('Malformed optimized Parquet geometry: missing required mesh column');
  }

  // The per-instance check below validates only vertexX/normalX/indices/matR,
  // but the loop also reads the sibling columns (vertexY/Z, normalY/Z, matG/B/A).
  // Verify presence + length parity once up front so a malformed payload with a
  // missing/short sibling fails loudly instead of producing NaN geometry/colors.
  if (!vertexX || !vertexY || !vertexZ || !indices || !matR || !matG || !matB || !matA) {
    throw new Error('Malformed optimized Parquet geometry: missing required column');
  }
  if (
    vertexX.length !== vertexY.length ||
    vertexX.length !== vertexZ.length ||
    matR.length !== matG.length ||
    matR.length !== matB.length ||
    matR.length !== matA.length ||
    (hasNormals &&
      (!normalX ||
        !normalY ||
        !normalZ ||
        normalX.length !== vertexX.length ||
        normalY.length !== vertexX.length ||
        normalZ.length !== vertexX.length))
  ) {
    throw new Error('Malformed optimized Parquet geometry: inconsistent parallel column lengths');
  }

  // Reconstruct MeshData array from instances
  const instanceCount = entityIds.length;
  const meshes: MeshData[] = new Array(instanceCount);
  const dequantMultiplier = 1.0 / vertexMultiplier;

  // Additive per-instance origin/geometry_class columns (issue #1841): consume
  // only when present AND parallel to the instance rows.
  const hasInstOrigin = originIsUsable(instOriginX, instOriginY, instOriginZ, instanceCount);
  const hasInstGeometryClass = !!instGeometryClass && instGeometryClass.length === instanceCount;

  for (let i = 0; i < instanceCount; i++) {
    const meshIdx = meshIndices[i];
    const materialIdx = materialIndices[i];

    // Validate the untrusted cross-table indices before dereferencing, so a
    // bad index fails loudly instead of silently producing empty meshes /
    // NaN colors.
    if (meshIdx >= meshVertexOffsets.length || materialIdx >= matR.length) {
      throw new Error(
        `Malformed optimized Parquet geometry: instance ${i} references ` +
          `mesh ${meshIdx} (of ${meshVertexOffsets.length}) / ` +
          `material ${materialIdx} (of ${matR.length})`
      );
    }

    const vertexOffset = meshVertexOffsets[meshIdx];
    const vertexCount = meshVertexCounts[meshIdx];
    const indexOffset = meshIndexOffsets[meshIdx];
    const indexCount = meshIndexCounts[meshIdx];

    // Validate the resolved ranges against the actual vertex/index column
    // lengths (indices here are flat, not triangle-columnar — no %3 check).
    if (
      vertexOffset + vertexCount > vertexX.length ||
      (normalX && vertexOffset + vertexCount > normalX.length) ||
      indexOffset + indexCount > indices.length
    ) {
      throw new Error(
        `Malformed optimized Parquet geometry: instance ${i} range out of bounds ` +
          `(meshIdx=${meshIdx}, vertexOffset=${vertexOffset}, vertexCount=${vertexCount}, ` +
          `vertices=${vertexX.length}; indexOffset=${indexOffset}, indexCount=${indexCount}, ` +
          `indices=${indices.length})`
      );
    }

    // Dequantize and reconstruct positions
    // OPTIMIZATION: Z-up to Y-up transform is now done server-side for optimized format too
    // Server already transforms before quantization, so we just dequantize directly
    const positions = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v++) {
      const srcIdx = vertexOffset + v;
      positions[v * 3] = vertexX[srcIdx] * dequantMultiplier;
      positions[v * 3 + 1] = vertexY[srcIdx] * dequantMultiplier;
      positions[v * 3 + 2] = vertexZ[srcIdx] * dequantMultiplier;
    }

    // Reconstruct indices (relative to this mesh's vertices)
    const meshIndicesArray = new Uint32Array(indexCount);
    for (let j = 0; j < indexCount; j++) {
      meshIndicesArray[j] = indices[indexOffset + j];
    }

    // Reconstruct normals (pre-transformed server-side, or compute if not present)
    let normals: Float32Array;
    if (hasNormals && normalX && normalY && normalZ) {
      normals = new Float32Array(vertexCount * 3);
      for (let v = 0; v < vertexCount; v++) {
        const srcIdx = vertexOffset + v;
        normals[v * 3] = normalX[srcIdx];
        normals[v * 3 + 1] = normalY[srcIdx];
        normals[v * 3 + 2] = normalZ[srcIdx];
      }
    } else {
      // Compute flat normals from triangle faces
      normals = computeFlatNormals(positions, meshIndicesArray);
    }

    // Convert byte colors to float [0-1]. `positions` are the TEMPLATE-local
    // vertices; `origin` (not baked in, to keep f32 precision at building scale)
    // carries the per-instance placement so the renderer reconstructs
    // world = origin + position — the same contract as the standard path.
    meshes[i] = {
      express_id: entityIds[i],
      ifc_type: (ifcTypes?.get(i) as string) ?? 'Unknown',
      positions,
      normals,
      indices: meshIndicesArray,
      color: [
        matR[materialIdx] / 255,
        matG[materialIdx] / 255,
        matB[materialIdx] / 255,
        matA[materialIdx] / 255,
      ],
      ...transformFields(
        i,
        instOriginX,
        instOriginY,
        instOriginZ,
        hasInstOrigin,
        instGeometryClass,
        hasInstGeometryClass
      ),
    };
  }

  return meshes;
}

/**
 * Compute flat normals for a mesh from positions and indices.
 * Each triangle face gets a uniform normal.
 */
export function computeFlatNormals(
  positions: Float32Array,
  indices: number[] | Uint32Array
): Float32Array {
  const vertexCount = positions.length / 3;
  const normals = new Float32Array(vertexCount * 3).fill(0);
  const triangleCount = indices.length / 3;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    // Get triangle vertices
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

    // Compute edge vectors
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // Cross product
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    // Accumulate normals (will normalize later)
    normals[i0 * 3] += nx; normals[i0 * 3 + 1] += ny; normals[i0 * 3 + 2] += nz;
    normals[i1 * 3] += nx; normals[i1 * 3 + 1] += ny; normals[i1 * 3 + 2] += nz;
    normals[i2 * 3] += nx; normals[i2 * 3 + 1] += ny; normals[i2 * 3 + 2] += nz;
  }

  // Normalize
  for (let v = 0; v < vertexCount; v++) {
    const x = normals[v * 3], y = normals[v * 3 + 1], z = normals[v * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      normals[v * 3] /= len;
      normals[v * 3 + 1] /= len;
      normals[v * 3 + 2] /= len;
    }
  }

  return normals;
}
