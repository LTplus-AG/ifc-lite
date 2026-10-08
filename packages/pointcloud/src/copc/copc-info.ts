/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * COPC 1.0 header and `copc`/`info` VLR (#6869), from the specification at
 * https://copc.io.
 *
 * A COPC file is a LAS 1.4 file (point formats 6, 7 or 8, LAZ-compressed)
 * whose FIRST VLR is `copc`/1, a 160-byte record describing the octree cube
 * and where the root hierarchy page lives. Detection is by that VLR, not by
 * the `.copc.laz` file name: a renamed COPC file is still COPC and a plain
 * LAZ named `.copc.laz` is not.
 */

import { extractWktCrsIdentifiers } from '../spatial-wkt.js';
import { parseLasHeader, readU64LE, type LasHeader } from '../formats/las.js';
import type { PointCloudBBox } from '../types.js';
import type { PointSourceSpatialMetadata, RangeByteSource } from '../streaming/types.js';

/** Byte size of the LAS 1.4 public header block. */
export const LAS14_HEADER_SIZE = 375;
const VLR_HEADER_SIZE = 54;
const COPC_INFO_SIZE = 160;
/** Header + the `copc` VLR header + its payload: everything detection needs. */
export const COPC_PROBE_BYTES = LAS14_HEADER_SIZE + VLR_HEADER_SIZE + COPC_INFO_SIZE;
/** VLRs are control-plane metadata; a larger block is refused before allocation. */
export const MAX_COPC_VLR_BYTES = 16 << 20;
const COPC_POINT_FORMATS = new Set([6, 7, 8]);
const LASF_PROJECTION = 'LASF_Projection';
const WKT_RECORD_ID = 2112;

/** The `copc`/`info` VLR payload. */
export interface CopcInfo {
  /** Centre of the root octree cube, in native (unshifted) coordinates. */
  center: [number, number, number];
  /** Half the edge length of the root cube. */
  halfsize: number;
  /** Point spacing at the root level; halves with every level. */
  spacing: number;
  /** Absolute file offset of the root hierarchy page. */
  rootHierOffset: number;
  /** Byte size of the root hierarchy page (a multiple of 32). */
  rootHierSize: number;
  gpsTimeMin: number;
  gpsTimeMax: number;
}

/** Everything `openCopc` learns before touching point data. */
export interface CopcFileInfo {
  header: LasHeader;
  info: CopcInfo;
  fileSize: number;
  spatialMetadata?: PointSourceSpatialMetadata;
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = start; i < start + length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

/** True when `bytes` (at least `COPC_PROBE_BYTES` of a file's start) is a COPC header. */
export function isCopcHeader(bytes: Uint8Array): boolean {
  if (bytes.length < COPC_PROBE_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x4653414c) return false; // "LASF"
  if (view.getUint8(24) !== 1 || view.getUint8(25) !== 4) return false;
  const headerSize = view.getUint16(94, true);
  if (headerSize !== LAS14_HEADER_SIZE) return false;
  return readAscii(bytes, headerSize + 2, 16) === 'copc' && view.getUint16(headerSize + 18, true) === 1;
}

/** Parse the 160-byte `copc`/`info` payload. Throws on a non-finite or impossible cube. */
export function parseCopcInfo(payload: Uint8Array, fileSize: number): CopcInfo {
  if (payload.length < COPC_INFO_SIZE) throw new Error('COPC: info VLR truncated');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const center: [number, number, number] = [view.getFloat64(0, true), view.getFloat64(8, true), view.getFloat64(16, true)];
  const halfsize = view.getFloat64(24, true);
  const spacing = view.getFloat64(32, true);
  const rootHierOffset = readU64LE(view, 40);
  const rootHierSize = readU64LE(view, 48);
  const gpsTimeMin = view.getFloat64(56, true);
  const gpsTimeMax = view.getFloat64(64, true);
  if (!center.every(Number.isFinite)) throw new Error('COPC: info VLR has a non-finite octree centre');
  if (!(Number.isFinite(halfsize) && halfsize > 0)) throw new Error(`COPC: invalid octree halfsize ${halfsize}`);
  if (!(Number.isFinite(spacing) && spacing > 0)) throw new Error(`COPC: invalid root spacing ${spacing}`);
  if (rootHierSize <= 0 || rootHierSize % 32 !== 0) {
    throw new Error(`COPC: root hierarchy page size ${rootHierSize} is not a positive multiple of 32`);
  }
  if (rootHierOffset < LAS14_HEADER_SIZE || rootHierOffset + rootHierSize > fileSize) {
    throw new Error(`COPC: root hierarchy page [${rootHierOffset}, +${rootHierSize}) lies outside the ${fileSize}-byte file`);
  }
  return { center, halfsize, spacing, rootHierOffset, rootHierSize, gpsTimeMin, gpsTimeMax };
}

/**
 * Read the header and VLR block through `source`, validating that this is a
 * COPC file this reader can decode. Point data is not touched.
 */
export async function readCopcFileInfo(source: RangeByteSource, signal?: AbortSignal): Promise<CopcFileInfo> {
  const head = await source.read(0, COPC_PROBE_BYTES, signal);
  if (!isCopcHeader(head)) {
    throw new Error('COPC: not a COPC file (LAS 1.4 header whose first VLR is copc/info expected)');
  }
  const header = parseLasHeader(head);
  if (!COPC_POINT_FORMATS.has(header.pointDataFormatId)) {
    throw new Error(`COPC: point data format ${header.pointDataFormatId} is not one of 6, 7, 8`);
  }
  const vlrEnd = header.pointDataOffset;
  if (vlrEnd < COPC_PROBE_BYTES || vlrEnd > source.size) {
    throw new Error(`COPC: point data offset ${vlrEnd} lies outside the file`);
  }
  if (vlrEnd - LAS14_HEADER_SIZE > MAX_COPC_VLR_BYTES) {
    throw new Error(`COPC: VLR block of ${vlrEnd - LAS14_HEADER_SIZE} bytes exceeds the ${MAX_COPC_VLR_BYTES}-byte limit`);
  }
  const vlrs = vlrEnd > COPC_PROBE_BYTES
    ? concat(head, await source.read(COPC_PROBE_BYTES, vlrEnd, signal))
    : head;
  if (vlrs.length < vlrEnd) throw new Error('COPC: VLR block truncated');
  const info = parseCopcInfo(vlrs.subarray(LAS14_HEADER_SIZE + VLR_HEADER_SIZE, COPC_PROBE_BYTES), source.size);
  const wkt = findWkt(vlrs, header.numberOfVlrs, vlrEnd);
  const spatialMetadata = wkt
    ? { ...extractWktCrsIdentifiers(wkt), wkt, provenance: 'LAS OGC WKT VLR' }
    : undefined;
  return { header, info, fileSize: source.size, ...(spatialMetadata ? { spatialMetadata } : {}) };
}

/** Walk the VLR list (bounded by both the declared count and the byte block). */
function findWkt(bytes: Uint8Array, count: number, end: number): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = LAS14_HEADER_SIZE;
  for (let i = 0; i < count && at + VLR_HEADER_SIZE <= end; i++) {
    const userId = readAscii(bytes, at + 2, 16);
    const recordId = view.getUint16(at + 18, true);
    const length = view.getUint16(at + 20, true);
    const dataStart = at + VLR_HEADER_SIZE;
    if (dataStart + length > end) break;
    if (userId === LASF_PROJECTION && recordId === WKT_RECORD_ID) {
      return new TextDecoder().decode(bytes.subarray(dataStart, dataStart + length)).replace(/\0+$/, '');
    }
    at = dataStart + length;
  }
  return undefined;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** An octree address: level `d` and integer cell `x, y, z` in `[0, 2^d)`. */
export interface VoxelKey {
  d: number;
  x: number;
  y: number;
  z: number;
}

/** Stable string id for a key (`"d-x-y-z"`), the form COPC tools print. */
export function voxelKeyId(key: VoxelKey): string {
  return `${key.d}-${key.x}-${key.y}-${key.z}`;
}

/** The cube a node covers, in native coordinates: the root cube split `2^d` ways per axis. */
export function copcNodeBounds(info: CopcInfo, key: VoxelKey): PointCloudBBox {
  const side = (2 * info.halfsize) / 2 ** key.d;
  const min: [number, number, number] = [
    info.center[0] - info.halfsize + key.x * side,
    info.center[1] - info.halfsize + key.y * side,
    info.center[2] - info.halfsize + key.z * side,
  ];
  return { min, max: [min[0] + side, min[1] + side, min[2] + side] };
}
