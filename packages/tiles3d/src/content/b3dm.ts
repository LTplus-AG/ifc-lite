/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Batched 3D Model (b3dm) reader: 28-byte header, feature table
 * (BATCH_LENGTH, RTC_CENTER), batch table (JSON plus binary body) and the
 * embedded binary glTF. Layout per 3D Tiles 1.0 TileFormats/Batched3DModel.
 */

import { dataView, isCount, magicAt, own, parseJsonChunk } from '../bytes.js';
import { invalid, tooLarge } from '../limits.js';

export interface B3dm {
  version: number;
  batchLength: number;
  /** ECEF (or root-frame) offset all vertices are relative to, after the y-up to z-up step. */
  rtcCenter?: [number, number, number];
  featureTable: Record<string, unknown>;
  /** Batch table columns by name, each read for at most `batchLength` rows. */
  columns: Map<string, unknown[]>;
  /**
   * The batch table row of one batch id, built on demand so that a large
   * declared BATCH_LENGTH allocates nothing; undefined outside [0, batchLength).
   * Column names from the file become own data properties, so a column named
   * `__proto__`, `constructor` or `prototype` is kept as data and never touches
   * a prototype.
   */
  row(batchId: number): Record<string, unknown> | undefined;
  /** Batch table property names in file order. */
  attributeNames: string[];
  /** Embedded binary glTF. */
  glb: Uint8Array;
  warnings: string[];
}

const HEADER = 28;
/** A byte length this large means JSON text sits where the length should: a legacy header. */
const LEGACY_THRESHOLD = 570425344;

interface BinaryRef {
  byteOffset: number;
  /** Required in batch tables; feature table references omit it (implicit per semantic). */
  componentType: string;
  type?: string;
}

const COMPONENT_SIZE: Record<string, number> = {
  BYTE: 1, UNSIGNED_BYTE: 1, SHORT: 2, UNSIGNED_SHORT: 2, INT: 4, UNSIGNED_INT: 4, FLOAT: 4, DOUBLE: 8,
};
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readComponent(view: DataView, offset: number, componentType: string): number {
  switch (componentType) {
    case 'BYTE': return view.getInt8(offset);
    case 'UNSIGNED_BYTE': return view.getUint8(offset);
    case 'SHORT': return view.getInt16(offset, true);
    case 'UNSIGNED_SHORT': return view.getUint16(offset, true);
    case 'INT': return view.getInt32(offset, true);
    case 'UNSIGNED_INT': return view.getUint32(offset, true);
    case 'FLOAT': return view.getFloat32(offset, true);
    case 'DOUBLE': return view.getFloat64(offset, true);
    default: throw new Error(`unknown componentType ${componentType}`);
  }
}

function isBinaryRef(v: unknown): v is BinaryRef {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as BinaryRef).byteOffset === 'number';
}

/** Read `count` elements of a binary table property; the byte range is checked before anything is allocated. */
function readBinary(body: Uint8Array, ref: BinaryRef, count: number, defaultType: string): Array<number | number[]> {
  const size = own(COMPONENT_SIZE, ref.componentType);
  const n = own(TYPE_COUNT, ref.type ?? defaultType);
  if (!size || !n) throw invalid(`unsupported binary property ${String(ref.componentType)}/${String(ref.type)}`);
  if (!isCount(ref.byteOffset)) throw invalid(`binary property byteOffset ${ref.byteOffset} is not a non-negative integer`);
  if (ref.byteOffset + size * n * count > body.byteLength) {
    throw invalid('binary property extends past its table body');
  }
  const view = dataView(body);
  const out: Array<number | number[]> = [];
  for (let i = 0; i < count; i++) {
    const base = ref.byteOffset + i * size * n;
    if (n === 1) out.push(readComponent(view, base, ref.componentType));
    else out.push(Array.from({ length: n }, (_, k) => readComponent(view, base + k * size, ref.componentType)));
  }
  return out;
}

export function isB3dm(bytes: Uint8Array): boolean {
  return magicAt(bytes) === 'b3dm';
}

export function parseB3dm(bytes: Uint8Array): B3dm {
  if (bytes.byteLength < HEADER || !isB3dm(bytes)) throw invalid('not a b3dm tile');
  const view = dataView(bytes);
  const version = view.getUint32(4, true);
  const byteLength = view.getUint32(8, true);
  let ftJsonLen = view.getUint32(12, true);
  let ftBinLen = view.getUint32(16, true);
  let btJsonLen = view.getUint32(20, true);
  let btBinLen = view.getUint32(24, true);
  let offset = HEADER;
  let legacyBatchLength: number | undefined;
  const warnings: string[] = [];
  if (version !== 1) warnings.push(`b3dm version ${version} (expected 1)`);
  if (byteLength > bytes.byteLength) throw invalid(`b3dm byteLength ${byteLength} exceeds the ${bytes.byteLength} bytes received`);

  if (btJsonLen >= LEGACY_THRESHOLD) {
    // Legacy 20-byte header: [magic, version, byteLength, batchLength, batchTableByteLength].
    offset -= 8;
    legacyBatchLength = ftJsonLen;
    btJsonLen = ftBinLen;
    btBinLen = 0;
    ftJsonLen = 0;
    ftBinLen = 0;
    warnings.push('legacy 20-byte b3dm header');
  } else if (btBinLen >= LEGACY_THRESHOLD) {
    // Legacy 24-byte header: [magic, version, byteLength, batchTableJsonByteLength, batchTableBinaryByteLength, batchLength].
    offset -= 4;
    legacyBatchLength = btJsonLen;
    btJsonLen = ftJsonLen;
    btBinLen = ftBinLen;
    ftJsonLen = 0;
    ftBinLen = 0;
    warnings.push('legacy 24-byte b3dm header');
  }

  const end = Math.min(byteLength || bytes.byteLength, bytes.byteLength);
  const take = (len: number): Uint8Array => {
    if (offset + len > end) throw invalid('b3dm section extends past the tile');
    const s = bytes.subarray(offset, offset + len);
    offset += len;
    return s;
  };
  const ftJsonBytes = take(ftJsonLen);
  const ftBody = take(ftBinLen);
  const btJsonBytes = take(btJsonLen);
  const btBody = take(btBinLen);
  const glb = bytes.subarray(offset, end);

  const featureTable = asObject(ftJsonLen > 0 ? parseJsonChunk(ftJsonBytes, 0, ftJsonLen) : undefined, 'feature table');
  let batchLength = legacyBatchLength ?? 0;
  const bl = featureTable.BATCH_LENGTH;
  if (typeof bl === 'number') batchLength = bl;
  else if (isBinaryRef(bl)) batchLength = readBinary(ftBody, { byteOffset: bl.byteOffset, componentType: 'UNSIGNED_INT', type: 'SCALAR' }, 1, 'SCALAR')[0] as number;
  else if (bl !== undefined) throw invalid('BATCH_LENGTH is neither a number nor a binary reference');
  if (!isCount(batchLength)) throw invalid(`BATCH_LENGTH ${batchLength} is not a non-negative integer`);
  // Every feature needs at least one byte somewhere in the tile (a batch table
  // entry or a vertex), so a BATCH_LENGTH above the tile's byte length cannot
  // describe real features; refusing it keeps a 1 KB tile from declaring 2^32 rows.
  if (batchLength > bytes.byteLength) {
    throw tooLarge(`BATCH_LENGTH ${batchLength} exceeds what a ${bytes.byteLength}-byte tile can hold`);
  }

  let rtcCenter: [number, number, number] | undefined;
  const rtc = featureTable.RTC_CENTER;
  if (Array.isArray(rtc) && rtc.length === 3) rtcCenter = [Number(rtc[0]), Number(rtc[1]), Number(rtc[2])];
  else if (isBinaryRef(rtc)) {
    // Feature table binary references carry only byteOffset; RTC_CENTER is float32[3].
    rtcCenter = readBinary(ftBody, { byteOffset: rtc.byteOffset, componentType: 'FLOAT', type: 'VEC3' }, 1, 'VEC3')[0] as [number, number, number];
  }

  if (rtcCenter && !rtcCenter.every(Number.isFinite)) throw invalid('RTC_CENTER is not three finite numbers');

  const batchJson = asObject(btJsonLen > 0 ? parseJsonChunk(btJsonBytes, 0, btJsonLen) : undefined, 'batch table');
  const columns = new Map<string, unknown[]>();
  const attributeNames: string[] = [];
  for (const [name, value] of Object.entries(batchJson)) {
    if (name === 'extensions') {
      if (value && typeof value === 'object') for (const ext of Object.keys(value)) warnings.push(`batch table extension ${ext} not read`);
      continue;
    }
    if (name === 'extras') continue;
    let column: unknown[];
    if (Array.isArray(value)) column = value;
    else if (isBinaryRef(value)) {
      try {
        column = readBinary(btBody, value, batchLength, 'SCALAR');
      } catch (err) {
        warnings.push(`batch table property ${name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else {
      warnings.push(`batch table property ${name} is neither an array nor a binary reference`);
      continue;
    }
    if (column.length !== batchLength) warnings.push(`batch table property ${name} has ${column.length} values for BATCH_LENGTH ${batchLength}`);
    attributeNames.push(name);
    columns.set(name, column.length > batchLength ? column.slice(0, batchLength) : column);
  }
  const row = (batchId: number): Record<string, unknown> | undefined => {
    if (!Number.isInteger(batchId) || batchId < 0 || batchId >= batchLength) return undefined;
    const out: Record<string, unknown> = {};
    for (const [name, column] of columns) {
      if (batchId < column.length) Object.defineProperty(out, name, { value: column[batchId], enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return { version, batchLength, rtcCenter, featureTable, columns, row, attributeNames, glb, warnings };
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(`${what} JSON is not an object`);
  return v as Record<string, unknown>;
}
