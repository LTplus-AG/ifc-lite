// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parquet decoder for server geometry responses.
 *
 * Decodes the binary Parquet format from the server into MeshData[].
 * Uses parquet-wasm for efficient Parquet parsing in the browser.
 */

import type { MeshData } from './types.js';

// Ambient types in vendor-types.d.ts cover parquet-wasm and apache-arrow APIs.

// WASM initialization state
let parquetInitialized = false;
let parquetModule: typeof import('parquet-wasm/esm/arrow2.js') | null = null;

/**
 * Ensure parquet-wasm WASM module is initialized.
 * This MUST be called before using any parquet functions.
 * 
 * @returns Initialized parquet-wasm module
 */
export async function ensureParquetInit() {
  if (parquetInitialized && parquetModule) {
    return parquetModule;
  }

  console.log('[parquet-decoder] Starting WASM initialization...');

  let parquet: typeof import('parquet-wasm/esm/arrow2.js') | undefined;

  // Strategy 1: Try ESM build with explicit WASM URL (works with Vite)
  try {
    parquet = await import('parquet-wasm/esm/arrow2.js');
    console.log('[parquet-decoder] Imported ESM build');

    // ESM build requires calling init (default export) to load WASM
    if (typeof parquet.default === 'function') {
      console.log('[parquet-decoder] Calling ESM init to load WASM...');

      // Get the WASM file URL - Vite handles this with ?url suffix
      const wasmModule = await import('parquet-wasm/esm/arrow2_bg.wasm?url');
      const wasmUrl = wasmModule.default;
      console.log('[parquet-decoder] Loading WASM from:', wasmUrl);

      // Pass the URL to init so it can fetch the WASM correctly
      await parquet.default(wasmUrl);
      console.log('[parquet-decoder] ESM WASM initialized');
    }

    if (typeof parquet.readParquet === 'function') {
      parquetModule = parquet;
      parquetInitialized = true;
      console.log('[parquet-decoder] ESM build ready with readParquet');
      return parquet;
    } else {
      console.warn('[parquet-decoder] ESM build initialized but readParquet not found');
    }
  } catch (e) {
    console.warn('[parquet-decoder] ESM import failed:', e);
  }

  // Strategy 2: Try web build with fetch (alternative for browsers)
  try {
    parquet = await import('parquet-wasm/esm/arrow2.js');

    if (typeof parquet.default === 'function') {
      console.log('[parquet-decoder] Trying web init with node_modules path...');

      // Try common paths where WASM might be served
      const wasmPaths = [
        '/node_modules/parquet-wasm/esm/arrow2_bg.wasm',
        './node_modules/parquet-wasm/esm/arrow2_bg.wasm',
      ];

      for (const wasmPath of wasmPaths) {
        try {
          const response = await fetch(wasmPath);
          if (response.ok) {
            console.log('[parquet-decoder] Found WASM at:', wasmPath);
            await parquet.default(response);

            if (typeof parquet.readParquet === 'function') {
              parquetModule = parquet;
              parquetInitialized = true;
              console.log('[parquet-decoder] Web init successful');
              return parquet;
            }
          }
        } catch {
          // Try next path
        }
      }
    }
  } catch (e2) {
    console.warn('[parquet-decoder] Web init failed:', e2);
  }

  throw new Error('parquet-wasm: Could not load WASM module. Ensure parquet-wasm is installed and WASM files are accessible.');
}

/**
 * Decoded mesh metadata from Parquet.
 */
interface MeshMetadata {
  express_id: number;
  ifc_type: string;
  vertex_start: number;
  vertex_count: number;
  index_start: number;
  index_count: number;
  color_r: number;
  color_g: number;
  color_b: number;
  color_a: number;
}

/**
 * Decode a Parquet geometry response from the server.
 *
 * Binary format:
 * - [mesh_parquet_len:u32][mesh_parquet_data]
 * - [vertex_parquet_len:u32][vertex_parquet_data]
 * - [index_parquet_len:u32][index_parquet_data]
 *
 * @param data - Binary Parquet response from server
 * @returns Decoded MeshData array
 */
export async function decodeParquetGeometry(data: ArrayBuffer): Promise<MeshData[]> {
  // Initialize WASM module (only runs once)
  const parquet = await ensureParquetInit();

  const view = new DataView(data);
  let offset = 0;

  // Read mesh Parquet section
  const meshParquetLen = view.getUint32(offset, true);
  offset += 4;
  const meshParquetData = new Uint8Array(data, offset, meshParquetLen);
  offset += meshParquetLen;

  // Read vertex Parquet section
  const vertexParquetLen = view.getUint32(offset, true);
  offset += 4;
  const vertexParquetData = new Uint8Array(data, offset, vertexParquetLen);
  offset += vertexParquetLen;

  // Read index Parquet section
  const indexParquetLen = view.getUint32(offset, true);
  offset += 4;
  const indexParquetData = new Uint8Array(data, offset, indexParquetLen);

  // Parse Parquet tables
  const meshTable = parquet.readParquet(meshParquetData);
  const vertexTable = parquet.readParquet(vertexParquetData);
  const indexTable = parquet.readParquet(indexParquetData);

  // Convert to Arrow tables for easier access
  const arrow = await import('apache-arrow');

  const meshArrow = arrow.tableFromIPC(meshTable.intoIPCStream());
  const vertexArrow = arrow.tableFromIPC(vertexTable.intoIPCStream());
  const indexArrow = arrow.tableFromIPC(indexTable.intoIPCStream());

  // Extract columns from mesh table
  const expressIds = meshArrow.getChild('express_id')?.toArray() as Uint32Array;
  const ifcTypes = meshArrow.getChild('ifc_type');
  const vertexStarts = meshArrow.getChild('vertex_start')?.toArray() as Uint32Array;
  const vertexCounts = meshArrow.getChild('vertex_count')?.toArray() as Uint32Array;
  const indexStarts = meshArrow.getChild('index_start')?.toArray() as Uint32Array;
  const indexCounts = meshArrow.getChild('index_count')?.toArray() as Uint32Array;
  const colorR = meshArrow.getChild('color_r')?.toArray() as Float32Array;
  const colorG = meshArrow.getChild('color_g')?.toArray() as Float32Array;
  const colorB = meshArrow.getChild('color_b')?.toArray() as Float32Array;
  const colorA = meshArrow.getChild('color_a')?.toArray() as Float32Array;

  // Extract columns from vertex table
  const posX = vertexArrow.getChild('x')?.toArray() as Float32Array;
  const posY = vertexArrow.getChild('y')?.toArray() as Float32Array;
  const posZ = vertexArrow.getChild('z')?.toArray() as Float32Array;
  const normX = vertexArrow.getChild('nx')?.toArray() as Float32Array;
  const normY = vertexArrow.getChild('ny')?.toArray() as Float32Array;
  const normZ = vertexArrow.getChild('nz')?.toArray() as Float32Array;

  // Extract columns from index table
  const idx0 = indexArrow.getChild('i0')?.toArray() as Uint32Array;
  const idx1 = indexArrow.getChild('i1')?.toArray() as Uint32Array;
  const idx2 = indexArrow.getChild('i2')?.toArray() as Uint32Array;

  // Reconstruct MeshData array
  const meshCount = expressIds.length;
  const meshes: MeshData[] = new Array(meshCount);

  for (let i = 0; i < meshCount; i++) {
    const vertexStart = vertexStarts[i];
    const vertexCount = vertexCounts[i];
    const indexStart = indexStarts[i];
    const indexCount = indexCounts[i];

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
    };
  }

  return meshes;
}

/**
 * Check if parquet-wasm is available and can be initialized.
 *
 * @returns true if parquet-wasm can be imported and initialized
 */
export async function isParquetAvailable(): Promise<boolean> {
  try {
    // Try to initialize WASM - this is the real test
    await ensureParquetInit();
    return true;
  } catch (err) {
    console.warn('[parquet-decoder] Parquet WASM initialization failed:', err);
    return false;
  }
}

// ============================================================================
// OPTIMIZED FORMAT (ara3d BOS-compatible)
// ============================================================================

/**
 * Decode an optimized Parquet geometry response (ara3d BOS format).
 *
 * Binary format:
 * - [version:u8][flags:u8]
 * - [instance_len:u32][mesh_len:u32][material_len:u32][vertex_len:u32][index_len:u32]
 * - [instance_parquet][mesh_parquet][material_parquet][vertex_parquet][index_parquet]
 *
 * Key features:
 * - Integer quantized vertices (multiply by vertex_multiplier to get meters)
 * - Mesh instancing (deduplicated geometry)
 * - Byte colors (0-255)
 * - Optional normals (compute on client if not present)
 *
 * @param data - Binary optimized Parquet response from server
 * @param vertexMultiplier - Multiplier for vertex dequantization (default: 10000)
 * @returns Decoded MeshData array
 */
export async function decodeOptimizedParquetGeometry(
  data: ArrayBuffer,
  vertexMultiplier: number = 10000
): Promise<MeshData[]> {
  // Initialize WASM module (only runs once)
  const parquet = await ensureParquetInit();
  const arrow = await import('apache-arrow');

  const view = new DataView(data);
  let offset = 0;

  // Read header
  const version = view.getUint8(offset);
  offset += 1;
  if (version !== 2) {
    throw new Error(`Unsupported optimized Parquet version: ${version}`);
  }

  const flags = view.getUint8(offset);
  offset += 1;
  const hasNormals = (flags & 1) !== 0;

  // Read table lengths
  const instanceLen = view.getUint32(offset, true);
  offset += 4;
  const meshLen = view.getUint32(offset, true);
  offset += 4;
  const materialLen = view.getUint32(offset, true);
  offset += 4;
  const vertexLen = view.getUint32(offset, true);
  offset += 4;
  const indexLen = view.getUint32(offset, true);
  offset += 4;

  // Read Parquet tables
  const instanceData = new Uint8Array(data, offset, instanceLen);
  offset += instanceLen;
  const meshData = new Uint8Array(data, offset, meshLen);
  offset += meshLen;
  const materialData = new Uint8Array(data, offset, materialLen);
  offset += materialLen;
  const vertexData = new Uint8Array(data, offset, vertexLen);
  offset += vertexLen;
  const indexData = new Uint8Array(data, offset, indexLen);

  // Parse Parquet tables
  const instanceTable = parquet.readParquet(instanceData);
  const meshTable = parquet.readParquet(meshData);
  const materialTable = parquet.readParquet(materialData);
  const vertexTable = parquet.readParquet(vertexData);
  const indexTable = parquet.readParquet(indexData);

  // Convert to Arrow
  const instanceArrow = arrow.tableFromIPC(instanceTable.intoIPCStream());
  const meshArrow = arrow.tableFromIPC(meshTable.intoIPCStream());
  const materialArrow = arrow.tableFromIPC(materialTable.intoIPCStream());
  const vertexArrow = arrow.tableFromIPC(vertexTable.intoIPCStream());
  const indexArrow = arrow.tableFromIPC(indexTable.intoIPCStream());

  // Extract instance columns
  const entityIds = instanceArrow.getChild('entity_id')?.toArray() as Uint32Array;
  const ifcTypes = instanceArrow.getChild('ifc_type');
  const meshIndices = instanceArrow.getChild('mesh_index')?.toArray() as Uint32Array;
  const materialIndices = instanceArrow.getChild('material_index')?.toArray() as Uint32Array;

  // Extract mesh columns
  const meshVertexOffsets = meshArrow.getChild('vertex_offset')?.toArray() as Uint32Array;
  const meshVertexCounts = meshArrow.getChild('vertex_count')?.toArray() as Uint32Array;
  const meshIndexOffsets = meshArrow.getChild('index_offset')?.toArray() as Uint32Array;
  const meshIndexCounts = meshArrow.getChild('index_count')?.toArray() as Uint32Array;

  // Extract material columns (bytes 0-255)
  const matR = materialArrow.getChild('r')?.toArray() as Uint8Array;
  const matG = materialArrow.getChild('g')?.toArray() as Uint8Array;
  const matB = materialArrow.getChild('b')?.toArray() as Uint8Array;
  const matA = materialArrow.getChild('a')?.toArray() as Uint8Array;

  // Extract vertex columns (quantized integers)
  const vertexX = vertexArrow.getChild('x')?.toArray() as Int32Array;
  const vertexY = vertexArrow.getChild('y')?.toArray() as Int32Array;
  const vertexZ = vertexArrow.getChild('z')?.toArray() as Int32Array;
  const normalX = hasNormals ? (vertexArrow.getChild('nx')?.toArray() as Float32Array) : null;
  const normalY = hasNormals ? (vertexArrow.getChild('ny')?.toArray() as Float32Array) : null;
  const normalZ = hasNormals ? (vertexArrow.getChild('nz')?.toArray() as Float32Array) : null;

  // Extract index column
  const indices = indexArrow.getChild('i')?.toArray() as Uint32Array;

  // Reconstruct MeshData array from instances
  const instanceCount = entityIds.length;
  const meshes: MeshData[] = new Array(instanceCount);
  const dequantMultiplier = 1.0 / vertexMultiplier;

  for (let i = 0; i < instanceCount; i++) {
    const meshIdx = meshIndices[i];
    const materialIdx = materialIndices[i];

    const vertexOffset = meshVertexOffsets[meshIdx];
    const vertexCount = meshVertexCounts[meshIdx];
    const indexOffset = meshIndexOffsets[meshIdx];
    const indexCount = meshIndexCounts[meshIdx];

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
      normals = computeFlatNormals(positions, indices.slice(indexOffset, indexOffset + indexCount));
    }

    // Reconstruct indices (relative to this mesh's vertices)
    const meshIndicesArray = new Uint32Array(indexCount);
    for (let j = 0; j < indexCount; j++) {
      meshIndicesArray[j] = indices[indexOffset + j];
    }

    // Convert byte colors to float [0-1]
    meshes[i] = {
      express_id: entityIds[i],
      ifc_type: (ifcTypes?.get(i) as string) ?? 'Unknown',
      positions,
      normals,
      indices: meshIndicesArray,
      color: [matR[materialIdx] / 255, matG[materialIdx] / 255, matB[materialIdx] / 255, matA[materialIdx] / 255],
    };
  }

  return meshes;
}

/**
 * Compute flat normals for a mesh from positions and indices.
 * Each triangle face gets a uniform normal.
 */
function computeFlatNormals(positions: Float32Array, indices: number[] | Uint32Array): Float32Array {
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
