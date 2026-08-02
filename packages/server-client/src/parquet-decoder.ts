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
import { buildMeshesFromTables, buildMeshesFromOptimizedTables } from './parquet-tables.js';

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

  // Convert to Arrow tables for easier access. apache-arrow's browser
  // export map hides the `.d.ts` from TS5's strict resolver — `any`
  // here mirrors what the rest of server-client does.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrow: any = await import('apache-arrow');

  const meshArrow = arrow.tableFromIPC(meshTable.intoIPCStream());
  const vertexArrow = arrow.tableFromIPC(vertexTable.intoIPCStream());
  const indexArrow = arrow.tableFromIPC(indexTable.intoIPCStream());

  // Column semantics (including the additive origin / geometry_class columns of
  // issue #1841) live in `parquet-tables.ts` so they are unit-testable without
  // booting parquet-wasm. Everything above is wire framing.
  return buildMeshesFromTables(meshArrow, vertexArrow, indexArrow);
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
  // apache-arrow's browser export map hides the `.d.ts` from TS5's
  // strict resolver — fall back to `any` for the dynamic import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrow: any = await import('apache-arrow');

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

  // As above: the column contract lives in `parquet-tables.ts`.
  return buildMeshesFromOptimizedTables({
    instanceArrow,
    meshArrow,
    materialArrow,
    vertexArrow,
    indexArrow,
    hasNormals,
    vertexMultiplier,
  });
}

