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

import { dataView, decodeUtf8, magicAt, parseJsonChunk } from '../bytes.js';

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
  return (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) return i === 0 ? glbBin : undefined;
    return decodeDataUri(b.uri);
  });
}

export function isGlb(bytes: Uint8Array): boolean {
  return magicAt(bytes) === 'glTF';
}

export function parseGlb(bytes: Uint8Array): Gltf {
  if (bytes.byteLength < 12 || !isGlb(bytes)) throw new Error('not a binary glTF');
  const view = dataView(bytes);
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`binary glTF version ${version} is not supported (glTF 2.0 only)`);
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12;
  let json: GltfDocument | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + chunkLength > length) throw new Error('glTF chunk extends past the file');
    if (chunkType === GLB_JSON) json = parseJsonChunk(bytes, offset, offset + chunkLength) as GltfDocument;
    else if (chunkType === GLB_BIN && !bin) bin = bytes.subarray(offset, offset + chunkLength);
    offset += chunkLength;
  }
  if (!json) throw new Error('binary glTF has no JSON chunk');
  return { json, buffers: resolveBuffers(json, bin) };
}

/** glTF JSON (`.gltf`) content; only embedded data: URI buffers are resolved. */
export function parseGltfJson(bytes: Uint8Array): Gltf {
  const json = JSON.parse(decodeUtf8(bytes)) as GltfDocument;
  return { json, buffers: resolveBuffers(json, undefined) };
}

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/** Byte range of a buffer view, resolved. */
export function bufferViewBytes(gltf: Gltf, index: number): Uint8Array {
  const bv = gltf.json.bufferViews?.[index];
  if (!bv) throw new Error(`bufferView ${index} missing`);
  const buf = gltf.buffers[bv.buffer];
  if (!buf) throw new Error(`buffer ${bv.buffer} is external or missing (only GLB and data: URI buffers are read)`);
  const start = bv.byteOffset ?? 0;
  if (start + bv.byteLength > buf.byteLength) throw new Error(`bufferView ${index} extends past its buffer`);
  return buf.subarray(start, start + bv.byteLength);
}

/** Read an accessor into a flat Float64Array of `count * size` values (normalised integers mapped to [-1, 1] / [0, 1]). */
export function readAccessor(gltf: Gltf, index: number): { values: Float64Array; size: number; count: number } {
  const acc = gltf.json.accessors?.[index];
  if (!acc) throw new Error(`accessor ${index} missing`);
  if (acc.sparse) throw new Error(`accessor ${index} is sparse (not supported)`);
  const size = TYPE_SIZE[acc.type];
  const bytesPer = COMPONENT_BYTES[acc.componentType];
  if (!size || !bytesPer) throw new Error(`accessor ${index} has unsupported type ${acc.type}/${acc.componentType}`);
  const values = new Float64Array(acc.count * size);
  if (acc.bufferView === undefined) return { values, size, count: acc.count };
  const bytes = bufferViewBytes(gltf, acc.bufferView);
  const stride = gltf.json.bufferViews?.[acc.bufferView]?.byteStride || size * bytesPer;
  const base = acc.byteOffset ?? 0;
  if (acc.count > 0 && base + (acc.count - 1) * stride + size * bytesPer > bytes.byteLength) {
    throw new Error(`accessor ${index} extends past its bufferView`);
  }
  const view = dataView(bytes);
  const norm = acc.normalized === true;
  for (let i = 0; i < acc.count; i++) {
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
  return { values, size, count: acc.count };
}
