/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The finished flat scene as bytes: the batches finalize produced, so a reopen
 * can draw the complete model without merging or uploading anything twice.
 *
 * Layout: a 16-byte header (magic, revision, table length, table CRC-32), a
 * JSON table, then 16-byte-aligned payloads the table addresses relative to
 * the payload start. Decoding returns views into the caller's buffer.
 */

import type { MeshFinish } from './types.js';
import type { SpatialChunkingConfig } from './chunk-grid.js';
import { BATCH_CONSTANTS } from './constants.js';
import { LOD_MIN_TRIANGLES } from './lod-simplify.js';

/**
 * Bump on ANY change to what a batch's bytes mean: vertex layout, quantization,
 * the merge or LOD builders, id lanes, this format. A stale snapshot is not
 * rejected by anything else and would draw garbage.
 */
export const SCENE_SNAPSHOT_REVISION = 2; // 2: per-batch lattice collapse guard (#9068)

const MAGIC = 0x53534649; // "IFSS"
const HEADER_BYTES = 16;
const PAYLOAD_ALIGN = 16;

type Vec3 = [number, number, number];

export interface SceneSnapshotBatch {
  key: string;
  color: [number, number, number, number];
  finish?: MeshFinish;
  origin?: Vec3;
  bounds?: { min: Vec3; max: Vec3 };
  quantized?: { min: Vec3; step: number };
  /** The batch's model when its pieces carry one; absent pieces stay unscoped. */
  modelIndex?: number;
  /** Accumulated CPU vertex bytes of the bucket, which routes later pieces. */
  vertexBytes: number;
  expressIds: Uint32Array;
  /** Position of each piece in the load's queue order, parallel to `expressIds`. */
  ordinals: Uint32Array;
  vertexData: Uint8Array;
  indices: Uint32Array;
  lod1Indices?: Uint32Array;
}

export interface SceneSnapshot {
  /** Every setting the batch bytes depend on; see {@link sceneSnapshotPolicy}. */
  policy: string;
  pieceCount: number;
  nextSplitId: number;
  sharedFrameOrigins: [number, Vec3][];
  activeBuckets: [string, string][];
  batches: SceneSnapshotBatch[];
  /** The host's own JSON-safe state, stored and returned as is. */
  hostData?: unknown;
}

/** Everything outside the source geometry that decides a batch's bytes. */
export function sceneSnapshotPolicy(quantized: boolean, lod: boolean, chunking: SpatialChunkingConfig | null): string {
  return [SCENE_SNAPSHOT_REVISION, BATCH_CONSTANTS.BYTES_PER_VERTEX, quantized ? 'q' : 'f',
    lod ? `lod${LOD_MIN_TRIANGLES}` : 'nolod', chunking ? chunking.cellSize : 'nochunk'].join('|');
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

type PayloadRef = [offset: number, length: number];

interface BatchTableRow extends Omit<SceneSnapshotBatch, 'expressIds' | 'ordinals' | 'vertexData' | 'indices' | 'lod1Indices'> {
  expressIds: PayloadRef;
  ordinals: PayloadRef;
  vertexData: PayloadRef;
  indices: PayloadRef;
  lod1Indices?: PayloadRef;
}

interface SnapshotTable extends Omit<SceneSnapshot, 'batches'> {
  payloadBytes: number;
  batches: BatchTableRow[];
}

export function encodeSceneSnapshot(snapshot: SceneSnapshot): Blob {
  const payloads: Uint8Array[] = [];
  let payloadBytes = 0;
  const place = (view: ArrayBufferView): PayloadRef => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const offset = payloadBytes;
    payloads.push(bytes);
    payloadBytes += bytes.byteLength;
    const padding = -payloadBytes & (PAYLOAD_ALIGN - 1);
    if (padding) payloads.push(new Uint8Array(padding));
    payloadBytes += padding;
    return [offset, bytes.byteLength];
  };
  const table: SnapshotTable = { ...snapshot, payloadBytes: 0, batches: snapshot.batches.map(({ expressIds, ordinals, vertexData, indices, lod1Indices, ...row }) => ({
    ...row,
    expressIds: place(expressIds),
    ordinals: place(ordinals),
    vertexData: place(vertexData),
    indices: place(indices),
    ...(lod1Indices ? { lod1Indices: place(lod1Indices) } : {}),
  })) };
  table.payloadBytes = payloadBytes;
  const tableBytes = new TextEncoder().encode(JSON.stringify(table));
  const header = new DataView(new ArrayBuffer(HEADER_BYTES));
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, SCENE_SNAPSHOT_REVISION, true);
  header.setUint32(8, tableBytes.byteLength, true);
  header.setUint32(12, crc32(tableBytes), true);
  const tablePadding = new Uint8Array(-(HEADER_BYTES + tableBytes.byteLength) & (PAYLOAD_ALIGN - 1));
  return new Blob([header.buffer, tableBytes, tablePadding, ...payloads] as BlobPart[]);
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/** The snapshot in `buffer`, or null for anything this build must not draw. */
export function decodeSceneSnapshot(buffer: ArrayBuffer): SceneSnapshot | null {
  if (buffer.byteLength < HEADER_BYTES) return null;
  const header = new DataView(buffer);
  const tableBytes = header.getUint32(8, true);
  if (header.getUint32(0, true) !== MAGIC || header.getUint32(4, true) !== SCENE_SNAPSHOT_REVISION
    || HEADER_BYTES + tableBytes > buffer.byteLength) return null;
  const tableView = new Uint8Array(buffer, HEADER_BYTES, tableBytes);
  if (crc32(tableView) !== header.getUint32(12, true)) return null;
  let table: SnapshotTable;
  try {
    table = JSON.parse(new TextDecoder().decode(tableView)) as SnapshotTable;
  } catch (err) {
    console.warn('[Scene] snapshot table did not parse', err);
    return null;
  }
  const start = (HEADER_BYTES + tableBytes + PAYLOAD_ALIGN - 1) & -PAYLOAD_ALIGN;
  if (start + table.payloadBytes !== buffer.byteLength || !Array.isArray(table.batches)) return null;
  const inRange = ([offset, length]: PayloadRef, width: number) => offset >= 0 && length >= 0
    && offset % PAYLOAD_ALIGN === 0 && length % width === 0 && offset + length <= table.payloadBytes;
  const u32 = ([offset, length]: PayloadRef) => new Uint32Array(buffer, start + offset, length / 4);
  const batches: SceneSnapshotBatch[] = [];
  for (const { expressIds, ordinals, vertexData, indices, lod1Indices, ...row } of table.batches) {
    if (!inRange(expressIds, 4) || !inRange(ordinals, 4) || !inRange(vertexData, 1) || !inRange(indices, 4)
      || (lod1Indices && !inRange(lod1Indices, 4)) || expressIds[1] !== ordinals[1]
      || (row.origin !== undefined && !isVec3(row.origin))) return null;
    batches.push({ ...row, expressIds: u32(expressIds), ordinals: u32(ordinals),
      vertexData: new Uint8Array(buffer, start + vertexData[0], vertexData[1]),
      indices: u32(indices), ...(lod1Indices ? { lod1Indices: u32(lod1Indices) } : {}) });
  }
  return { policy: table.policy, pieceCount: table.pieceCount, nextSplitId: table.nextSplitId,
    sharedFrameOrigins: table.sharedFrameOrigins, activeBuckets: table.activeBuckets, batches, hostData: table.hostData };
}
