/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact GPU-layout geometry: the wire contract between the geometry worker,
 * the main thread and the renderer.
 *
 * The wasm `MeshCollection.encodeCompact` writes a batch's eligible flat meshes
 * as the renderer's final 12-byte quantized vertex records (welded on a lattice
 * in the model's RTC-relative frame, relative to the window of their cell),
 * mesh-local u16 indices and an f64 box per mesh. The worker transfers those
 * columns as they are and the renderer uploads them with `writeBuffer`; no
 * JavaScript reads a vertex on the way.
 *
 * A compact mesh still travels as a `MeshData` (id, colour, class, origin) with
 * `compact` naming its row. `compact-shell.ts` makes its `positions`, `normals`
 * and `indices` decode from the records on first read.
 */

/** One wasm batch call's compact output, as transferred. */
export interface CompactPayload {
  /** 12 bytes per welded vertex: u16 x, y, z offsets, u16 oct normal, u32 entity lane. */
  records: Uint8Array;
  /** Mesh-local u16 triangle indices. */
  indices: Uint16Array;
  /** Per row (`COMPACT_TABLE_STRIDE` columns): mesh index in its collection, vertex start, vertex
   *  count, index start, index count, lattice level (step = 2^-level m), source vertex count. */
  table: Uint32Array;
  /** Per row: lattice window origin in units of the row's step, xyz. */
  windows: Float64Array;
  /** Per row: box in the mesh frame (`origin + position`, Y-up), min xyz then max xyz. */
  bounds: Float64Array;
  /** Per row: cell indices xyz at the row's level. */
  cells: Int32Array;
}

/** A compact mesh's row: its payload and row number. */
export interface CompactRef {
  payload: CompactPayload;
  row: number;
  /** The mesh `origin` the records were adopted under: a mesh moved by rewriting its origin no longer matches them. */
  origin?: readonly [number, number, number];
}

/** Wire form of `CompactRef` inside a worker batch message: an index into its `compactBatches`. */
export interface CompactWireRef {
  batch: number;
  row: number;
}

/** The wasm `CompactBatch` surface this module reads. */
interface CompactBatchJs {
  readonly meshCount: number;
  readonly records: Uint8Array;
  readonly indices: Uint16Array;
  readonly table: Uint32Array;
  readonly windows: Float64Array;
  readonly bounds: Float64Array;
  readonly cells: Int32Array;
  free(): void;
}

/** u32 columns per table row. */
export const COMPACT_TABLE_STRIDE = 7;
/** Bytes per vertex record. */
export const COMPACT_RECORD_BYTES = 12;
/** Cell size the viewer encodes at: half a level-10 window, the largest the encoder accepts. */
export const COMPACT_CELL_METRES = 32;

/**
 * Whether `size` turns compact records on: a finite cell size above zero. The one test the host
 * (`compactCellSize`), the worker and the viewer's cache gate share, so they cannot disagree.
 */
export function isCompactCellSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isFinite(size) && size > 0;
}

/** One row's table columns. */
export interface CompactRow {
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  /** Lattice level: step = 2^-level metres. */
  level: number;
  /** Vertices of the source f32 mesh, before welding: what a scan of its positions would count. */
  sourceVertexCount: number;
}

export function compactRow(ref: CompactRef): CompactRow {
  const t = ref.payload.table, r = ref.row * COMPACT_TABLE_STRIDE;
  return { vertexStart: t[r + 1], vertexCount: t[r + 2], indexStart: t[r + 3], indexCount: t[r + 4], level: t[r + 5], sourceVertexCount: t[r + 6] };
}

/** Lattice step of a level in metres (level 10 is the renderer's `QUANT_STEP`). */
export function compactStep(level: number): number {
  return 2 ** -level;
}

/** A compact mesh's box: a `[minx, miny, minz, maxx, maxy, maxz]` view into its payload. */
export function compactBounds(ref: CompactRef): Float64Array {
  return ref.payload.bounds.subarray(ref.row * 6, ref.row * 6 + 6);
}

/** Every array of a payload. One compact mesh keeps the whole payload of its batch alive, not only its own rows. */
function payloadArrays(p: CompactPayload): ArrayBufferView[] {
  return [p.records, p.indices, p.table, p.windows, p.bounds, p.cells];
}

/** The payload's buffers, for a transfer list (each wasm getter returned a standalone copy). */
export function compactPayloadTransfers(p: CompactPayload): ArrayBuffer[] {
  return payloadArrays(p).map((a) => a.buffer as ArrayBuffer);
}

/**
 * Hand a memory census every array a compact mesh retains: the records, the indices and the four
 * per-row tables. The one walk both censuses use (the renderer's and the viewer's), so neither undercounts.
 */
export function visitCompactPayload(p: CompactPayload, visit: (array: ArrayBufferView, kind: 'indices' | 'other') => void): void {
  for (const array of payloadArrays(p)) visit(array, array === p.indices ? 'indices' : 'other');
}

/**
 * Worker side: encode a collection's eligible meshes BEFORE its meshes are read (an encoded mesh's
 * getters then return empty arrays), append the payload to `payloads`, and return mesh index -> wire
 * ref. `undefined` when nothing was encoded or the wasm build has no encoder.
 */
/** The six columns an `@ifc-lite/wasm` older than the source vertex count writes per row. */
const LEGACY_COMPACT_TABLE_STRIDE = 6;

/**
 * `table` with `COMPACT_TABLE_STRIDE` columns per row. A wasm build that predates the source vertex count
 * (a published patch range lets it pair with this package) writes six: widen it, taking the welded vertex
 * count as the source count, as before. Any other shape would misread every row after the encoder consumed
 * the meshes, so there is no f32 to fall back to: fail loudly.
 */
export function compactTableOf(table: Uint32Array, rows: number): Uint32Array {
  if (table.length === rows * COMPACT_TABLE_STRIDE) return table;
  if (table.length !== rows * LEGACY_COMPACT_TABLE_STRIDE) {
    throw new Error(`compact geometry: the wasm table has ${table.length} cells for ${rows} rows (expected ${COMPACT_TABLE_STRIDE} or ${LEGACY_COMPACT_TABLE_STRIDE} columns)`);
  }
  const wide = new Uint32Array(rows * COMPACT_TABLE_STRIDE);
  for (let row = 0; row < rows; row++) {
    const from = row * LEGACY_COMPACT_TABLE_STRIDE, to = row * COMPACT_TABLE_STRIDE;
    wide.set(table.subarray(from, from + LEGACY_COMPACT_TABLE_STRIDE), to);
    wide[to + 6] = table[from + 2]; // vertex count
  }
  return wide;
}

export function encodeCompactCollection(
  collection: object,
  cellSize: number,
  payloads: CompactPayload[],
): Map<number, CompactWireRef> | undefined {
  const encoder = collection as { encodeCompact?: (cellSize: number) => CompactBatchJs };
  if (typeof encoder.encodeCompact !== 'function') return undefined;
  const batch = encoder.encodeCompact(cellSize);
  try {
    const count = batch.meshCount;
    if (count === 0) return undefined;
    const payload: CompactPayload = {
      records: batch.records, indices: batch.indices, table: compactTableOf(batch.table, count),
      windows: batch.windows, bounds: batch.bounds, cells: batch.cells,
    };
    const index = payloads.length;
    payloads.push(payload);
    const rows = new Map<number, CompactWireRef>();
    for (let row = 0; row < count; row++) rows.set(payload.table[row * COMPACT_TABLE_STRIDE], { batch: index, row });
    return rows;
  } finally {
    batch.free();
  }
}
