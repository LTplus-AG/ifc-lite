/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal glTF 2.0 container and accessor reader for tile content.
 *
 * `@ifc-lite/cache` has a GLB importer, but it targets viewer MeshData (f32,
 * y-up, no Draco, no batch ids) and pulls in `@ifc-lite/geometry` and the wasm
 * package; this reader needs f64 output in the tileset frame, so it keeps its
 * own small container parser.
 */

import { dataView, decodeUtf8, isCount, magicAt, own, parseJsonChunk } from '../bytes.js';
import { DecodeLimitError, invalid } from '../limits.js';

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: unknown;
}

export interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}

export interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  name?: string;
}

export interface GltfDocument {
  asset?: { version?: string };
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[] }>;
  accessors?: GltfAccessor[];
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  buffers?: Array<{ uri?: string; byteLength: number }>;
  materials?: Array<{ name?: string; pbrMetallicRoughness?: { baseColorFactor?: number[] }; extensions?: Record<string, unknown> }>;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extensions?: Record<string, unknown>;
}

export interface Gltf {
  json: GltfDocument;
  /** Resolved buffers by index (GLB BIN chunk or data: URIs); undefined when external. */
  buffers: Array<Uint8Array | undefined>;
}

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;

function decodeDataUri(uri: string): Uint8Array | undefined {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!m) return undefined;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function resolveBuffers(json: GltfDocument, glbBin: Uint8Array | undefined): Array<Uint8Array | undefined> {
  if (json.buffers !== undefined && !Array.isArray(json.buffers)) throw invalid('glTF buffers is not an array');
  return (json.buffers ?? []).map((b, i) => {
    if (!b || typeof b !== 'object' || b.uri === undefined) return i === 0 ? glbBin : undefined;
    return typeof b.uri === 'string' ? decodeDataUri(b.uri) : undefined;
  });
}

export function isGlb(bytes: Uint8Array): boolean {
  return magicAt(bytes) === 'glTF';
}

export function parseGlb(bytes: Uint8Array): Gltf {
  if (bytes.byteLength < 12 || !isGlb(bytes)) throw invalid('not a binary glTF');
  const view = dataView(bytes);
  const version = view.getUint32(4, true);
  if (version !== 2) throw invalid(`binary glTF version ${version} is not supported (glTF 2.0 only)`);
  const declared = view.getUint32(8, true);
  // A header that declares more than was received is a truncated download, not a smaller file: report it.
  if (declared > bytes.byteLength) throw invalid(`binary glTF is truncated: its header declares ${declared} bytes but ${bytes.byteLength} were received`);
  const length = declared;
  let offset = 12;
  let json: GltfDocument | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > length) throw invalid('glTF chunk extends past the file');
    if (chunkType === GLB_JSON) json = parseJsonChunk(bytes, offset, offset + chunkLength) as GltfDocument;
    else if (chunkType === GLB_BIN && !bin) bin = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalid('binary glTF has no JSON object chunk');
  return { json, buffers: resolveBuffers(json, bin) };
}

/** glTF JSON (`.gltf`) content; only embedded data: URI buffers are resolved. */
export function parseGltfJson(bytes: Uint8Array): Gltf {
  const json = JSON.parse(decodeUtf8(bytes)) as GltfDocument;
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw invalid('glTF JSON is not an object');
  return { json, buffers: resolveBuffers(json, undefined) };
}

const COMPONENT_BYTES: Record<string, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const INDEX_COMPONENT_TYPES = new Set([5121, 5123, 5125]);

function componentBytes(componentType: unknown): number | undefined {
  return typeof componentType === 'number' ? own(COMPONENT_BYTES, String(componentType)) : undefined;
}

function at<T>(list: T[] | undefined, index: unknown, what: string): T {
  const item = isCount(index) && Array.isArray(list) ? list[index] : undefined;
  if (item === undefined || item === null || typeof item !== 'object') throw invalid(`${what} ${String(index)} missing`);
  return item;
}

/** Byte range of a buffer view, resolved; offsets and lengths are validated against the buffer first. */
export function bufferViewBytes(gltf: Gltf, index: number): Uint8Array {
  const bv = at(gltf.json.bufferViews, index, 'bufferView');
  const start = bv.byteOffset ?? 0;
  if (!isCount(start) || !isCount(bv.byteLength)) throw invalid(`bufferView ${index} has a negative or non-integer byteOffset/byteLength`);
  const buf = isCount(bv.buffer) ? gltf.buffers[bv.buffer] : undefined;
  if (!buf) throw invalid(`buffer ${String(bv.buffer)} is external or missing (only GLB and data: URI buffers are read)`);
  if (start + bv.byteLength > buf.byteLength) throw invalid(`bufferView ${index} extends past its buffer`);
  return buf.subarray(start, start + bv.byteLength);
}

export interface AccessorRequest {
  /** Per-content decode limit for `count`; checked before anything is allocated. */
  maxCount: number;
  /** Accessor types the caller accepts (e.g. `['VEC3']` for POSITION). */
  types: readonly string[];
  /** Name for messages, e.g. `POSITION`. */
  what: string;
}

/**
 * The validated `count` of an accessor: a non-negative integer no larger than
 * `maxCount` (a per-content decode limit; exceeding it throws
 * `DecodeLimitError`). Used for declared counts before anything is decoded.
 */
export function accessorCount(gltf: Gltf, index: number, req: Pick<AccessorRequest, 'maxCount' | 'what'>): number {
  const acc = at(gltf.json.accessors, index, 'accessor');
  if (!isCount(acc.count)) throw invalid(`accessor ${index} (${req.what}) count ${String(acc.count)} is not a non-negative integer`);
  if (acc.count > req.maxCount) throw new DecodeLimitError('content', `accessor ${index} (${req.what}) declares ${acc.count} elements, above the per-content limit of ${req.maxCount}`);
  return acc.count;
}

interface AccessorLayout {
  acc: GltfAccessor;
  size: number;
  bytesPer: number;
  count: number;
  /** Source bytes, stride and first byte; undefined for an accessor without a bufferView (all zeros). */
  source?: { view: DataView; stride: number; base: number };
}

/**
 * Validate an accessor completely (count against `maxCount`, type, component
 * type, offsets, stride, and the byte range against its bufferView) before the
 * caller allocates its output.
 */
function layout(gltf: Gltf, index: number, req: AccessorRequest): AccessorLayout {
  const count = accessorCount(gltf, index, req);
  const acc = gltf.json.accessors![index];
  if (acc.sparse) throw invalid(`accessor ${index} is sparse (not supported)`);
  const size = own(TYPE_SIZE, acc.type);
  const bytesPer = componentBytes(acc.componentType);
  if (!size || !bytesPer) throw invalid(`accessor ${index} has unsupported type ${String(acc.type)}/${String(acc.componentType)}`);
  if (!req.types.includes(acc.type)) throw invalid(`accessor ${index} (${req.what}) has type ${acc.type}, expected ${req.types.join(' or ')}`);
  if (acc.bufferView === undefined) return { acc, size, bytesPer, count };
  const base = acc.byteOffset ?? 0;
  if (!isCount(base)) throw invalid(`accessor ${index} byteOffset ${String(base)} is negative or not an integer`);
  const bytes = bufferViewBytes(gltf, acc.bufferView);
  const element = size * bytesPer;
  const declaredStride = gltf.json.bufferViews![acc.bufferView].byteStride;
  if (declaredStride !== undefined && (!isCount(declaredStride) || declaredStride < element)) {
    throw invalid(`bufferView ${acc.bufferView} byteStride ${String(declaredStride)} is smaller than the ${element}-byte element of accessor ${index}`);
  }
  const stride = declaredStride || element;
  if (count > 0 && base + (count - 1) * stride + element > bytes.byteLength) {
    throw invalid(`accessor ${index} extends past its bufferView`);
  }
  return { acc, size, bytesPer, count, source: { view: dataView(bytes), stride, base } };
}

/** Read an accessor into a flat Float64Array of `count * size` values (normalised integers mapped to [-1, 1] / [0, 1]). */
export function readAccessor(gltf: Gltf, index: number, req: AccessorRequest): { values: Float64Array; size: number; count: number } {
  const { acc, size, bytesPer, count, source } = layout(gltf, index, req);
  const values = new Float64Array(count * size);
  if (!source) return { values, size, count };
  const { view, stride, base } = source;
  const norm = acc.normalized === true;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < size; k++) {
      const o = base + i * stride + k * bytesPer;
      let v: number;
      switch (acc.componentType) {
        case 5120: v = view.getInt8(o); if (norm) v = Math.max(v / 127, -1); break;
        case 5121: v = view.getUint8(o); if (norm) v /= 255; break;
        case 5122: v = view.getInt16(o, true); if (norm) v = Math.max(v / 32767, -1); break;
        case 5123: v = view.getUint16(o, true); if (norm) v /= 65535; break;
        case 5125: v = view.getUint32(o, true); break;
        default: v = view.getFloat32(o, true);
      }
      values[i * size + k] = v;
    }
  }
  return { values, size, count };
}

/** Read an index accessor. glTF indices are unsigned integer scalars; any other component type is refused, not coerced. */
export function readIndices(gltf: Gltf, index: number, maxCount: number): Uint32Array {
  const acc = at(gltf.json.accessors, index, 'accessor');
  if (!INDEX_COMPONENT_TYPES.has(acc.componentType)) {
    throw invalid(`index accessor ${index} has componentType ${String(acc.componentType)}; indices must be UNSIGNED_BYTE, UNSIGNED_SHORT or UNSIGNED_INT`);
  }
  const { bytesPer, count, source } = layout(gltf, index, { maxCount, types: ['SCALAR'], what: 'indices' });
  const out = new Uint32Array(count);
  if (!source) return out;
  const { view, stride, base } = source;
  for (let i = 0; i < count; i++) {
    const o = base + i * stride;
    out[i] = bytesPer === 1 ? view.getUint8(o) : bytesPer === 2 ? view.getUint16(o, true) : view.getUint32(o, true);
  }
  return out;
}
