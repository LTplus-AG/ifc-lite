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

// Ambient types in vendor-types.d.ts cover the apache-arrow APIs used here.
// parquet-wasm ships its own types, one set per build.

// WASM initialization state. The in-flight promise is cached too, so
// concurrent decodes share one init instead of racing two.
type ParquetModule = typeof import('parquet-wasm');
let parquetInit: Promise<ParquetModule> | null = null;

/**
 * Ensure parquet-wasm WASM module is initialized.
 * This MUST be called before using any parquet functions.
 *
 * @returns Initialized parquet-wasm module
 */
export async function ensureParquetInit(): Promise<ParquetModule> {
  parquetInit ??= loadParquet().catch((err) => {
    // Do not cache a failed init: a later call (e.g. after the WASM asset
    // becomes reachable) should be able to try again.
    parquetInit = null;
    throw err;
  });
  return parquetInit;
}

async function loadParquet(): Promise<ParquetModule> {
  // Import the package entry point and let its export map choose the build.
  // Deep-importing a build (this module used `parquet-wasm/esm/arrow2.js`)
  // breaks on parquet-wasm 0.6+, where that path no longer exists (#3845).
  const parquet = await import('parquet-wasm');

  // The browser/bundler ESM build does nothing until its default export is
  // awaited; without it every call throws `Cannot read properties of
  // undefined (reading '__wbindgen_malloc')`. The Node build initializes
  // itself on import and exposes no default init, hence the guard rather
  // than an unconditional call. Same shape as
  // packages/export/src/columns-to-parquet.ts.
  //
  // The cast is the price of that guard: TypeScript resolves the export map
  // under the `node` condition, so it only ever sees the Node build's types,
  // where `default` is the CommonJS namespace object and not callable. Which
  // build actually loads is a runtime question, so ask at runtime.
  const init = (parquet as { default?: unknown }).default;
  if (typeof init === 'function') {
    await (init as () => Promise<unknown>)();
  }

  if (typeof parquet.readParquet !== 'function') {
    throw new Error(
      'parquet-wasm: module loaded but readParquet is missing. ' +
        'Install a supported parquet-wasm version (see this package\'s peerDependencies).'
    );
  }

  return parquet;
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
  // v2: no rotation columns (pre-#3575), every instance decodes as identity.
  // v3: instance table carries rot0..rot8 (#3575) — `readRotationColumns`
  // (parquet-tables.ts) reads them when present; `buildMeshesFromOptimizedTables`
  // rejects a v3 payload that omits/truncates them (malformed wire data),
  // rather than silently falling back to identity as it would for v2.
  if (version !== 2 && version !== 3) {
    throw new Error(`Unsupported optimized Parquet version: ${version}`);
  }
  const wireVersion: 2 | 3 = version;

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
    wireVersion,
  });
}

