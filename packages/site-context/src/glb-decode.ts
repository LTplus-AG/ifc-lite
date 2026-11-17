/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `decodeSiteContextGlb`: read a site-context GLB back into the document it was written from.
 * The file's structure is checked before anything is copied out of it: chunk lengths against the
 * bytes there are, every accessor against its role, its buffer view and the BIN chunk, every index
 * against the vertex count, and every layer and feature node reference. A file that fails any of
 * that, or requires a glTF extension, is refused with `SiteContextFormatError`, never decoded into
 * a document that silently lacks geometry (#10480 review).
 */

import {
  CHUNK_BIN,
  CHUNK_JSON,
  EXTRAS_KEY,
  FLOAT,
  GLB_MAGIC,
  SITE_CONTEXT_FORMAT_VERSION,
  UNSIGNED_INT,
  type GltfJson,
  type GltfNode,
  type SiteContextGlbNodeExtras,
} from './glb-format.js';
import type { SiteContextDocument, SiteContextFeature, SiteContextLayer, SiteContextMesh } from './types.js';

/** The bytes are not a site-context GLB this version can read. */
export class SiteContextFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteContextFormatError';
  }
}

function readChunks(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  if (bytes.byteLength < 20) throw new SiteContextFormatError('too short to be a GLB');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new SiteContextFormatError('not a GLB (bad magic)');
  if (dv.getUint32(4, true) !== 2) throw new SiteContextFormatError(`unsupported GLB version ${dv.getUint32(4, true)}`);
  const total = dv.getUint32(8, true);
  if (total > bytes.byteLength) throw new SiteContextFormatError(`GLB declares ${total} bytes but has ${bytes.byteLength}: truncated`);
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= total; ) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    if (at + 8 + len > total) throw new SiteContextFormatError(`GLB chunk at byte ${at} runs past the end of the file`);
    const body = bytes.subarray(at + 8, at + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (type === CHUNK_BIN) bin = body;
    at += 8 + len;
  }
  if (!json) throw new SiteContextFormatError('GLB has no JSON chunk');
  if (json.extensionsRequired?.length) throw new SiteContextFormatError(`GLB requires glTF extensions this reader does not support: ${json.extensionsRequired.join(', ')}`);
  return { json, bin };
}

const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3 } as const;

function readAccessor<T extends Float32Array | Uint32Array>(json: GltfJson, bin: Uint8Array | null, index: number, kind: 'f32' | 'u32', type: keyof typeof WIDTH): T {
  const acc = json.accessors?.[index];
  const view = acc ? json.bufferViews?.[acc.bufferView] : undefined;
  if (!acc || !view || !bin) throw new SiteContextFormatError(`accessor ${index} is missing its data`);
  const expected = kind === 'f32' ? FLOAT : UNSIGNED_INT;
  if (acc.componentType !== expected) throw new SiteContextFormatError(`accessor ${index} has component type ${acc.componentType}, expected ${expected}`);
  if (acc.type !== type) throw new SiteContextFormatError(`accessor ${index} is ${acc.type}, expected ${type}`);
  if (!Number.isInteger(acc.count) || acc.count < 0) throw new SiteContextFormatError(`accessor ${index} has count ${acc.count}`);
  const start = view.byteOffset ?? 0;
  const byteLength = acc.count * WIDTH[type] * 4;
  const viewLength: unknown = view.byteLength;
  if (!Number.isInteger(start) || start < 0 || typeof viewLength !== 'number' || !Number.isInteger(viewLength) || viewLength < 0
    || byteLength > viewLength || start + viewLength > bin.byteLength || start + byteLength > bin.byteLength) {
    throw new SiteContextFormatError(`accessor ${index} (${byteLength} bytes at ${start}) does not fit its buffer view or the BIN chunk`);
  }
  // Copy: the BIN chunk is not guaranteed to sit 4-byte aligned in the caller's buffer.
  const slice = bin.slice(start, start + byteLength);
  return (kind === 'f32' ? new Float32Array(slice.buffer) : new Uint32Array(slice.buffer)) as T;
}

/** glTF (east, up, −north) → site frame (east, north, up). Exact. */
function fromGltfAxes(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = -src[i + 2];
    out[i + 2] = src[i + 1];
  }
  return out;
}

function readMesh(json: GltfJson, bin: Uint8Array | null, index: number): SiteContextMesh {
  const gltfMesh = json.meshes?.[index];
  const prim = gltfMesh?.primitives[0];
  if (!prim) throw new SiteContextFormatError(`mesh ${index} has no primitive`);
  const mesh: SiteContextMesh = {
    positions: fromGltfAxes(readAccessor<Float32Array>(json, bin, prim.attributes.POSITION, 'f32', 'VEC3')),
    normals: fromGltfAxes(readAccessor<Float32Array>(json, bin, prim.attributes.NORMAL, 'f32', 'VEC3')),
    indices: readAccessor<Uint32Array>(json, bin, prim.indices, 'u32', 'SCALAR'),
  };
  if (prim.attributes.TEXCOORD_0 !== undefined) mesh.uvs = readAccessor<Float32Array>(json, bin, prim.attributes.TEXCOORD_0, 'f32', 'VEC2');
  const vertices = mesh.positions.length / 3;
  if (mesh.normals.length !== mesh.positions.length || (mesh.uvs && mesh.uvs.length / 2 !== vertices)) {
    throw new SiteContextFormatError(`mesh ${index}: attribute counts differ`);
  }
  if (mesh.indices.length % 3 !== 0) throw new SiteContextFormatError(`mesh ${index}: ${mesh.indices.length} indices is not whole triangles`);
  for (const i of mesh.indices) if (i >= vertices) throw new SiteContextFormatError(`mesh ${index}: index ${i} is past its ${vertices} vertices`);
  const parts = gltfMesh?.extras?.[EXTRAS_KEY]?.parts;
  if (parts) {
    let next = 0;
    for (const p of parts) {
      if (p.firstIndex !== next || !(p.indexCount >= 0) || p.indexCount % 3 !== 0) throw new SiteContextFormatError(`mesh ${index}: part "${p.name}" is not the next contiguous triangle range`);
      next += p.indexCount;
    }
    if (next !== mesh.indices.length) throw new SiteContextFormatError(`mesh ${index}: parts cover ${next} of ${mesh.indices.length} indices`);
    mesh.parts = parts.map((p) => ({ name: p.name, firstIndex: p.firstIndex, indexCount: p.indexCount }));
  }
  return mesh;
}

function readFeature(json: GltfJson, bin: Uint8Array | null, node: GltfNode, docOrigin: [number, number, number]): SiteContextFeature {
  const x = node.extras?.[EXTRAS_KEY] as SiteContextGlbNodeExtras | undefined;
  if (!x) throw new SiteContextFormatError(`node "${node.name ?? '?'}" has no ${EXTRAS_KEY} extras`);
  const t = node.translation ?? [0, 0, 0];
  const origin: [number, number, number] = x.origin ?? [docOrigin[0] + t[0], docOrigin[1] - t[2], docOrigin[2] + t[1]];
  const feature: SiteContextFeature = {
    id: x.id,
    ifcType: x.ifcType,
    name: x.name,
    origin,
    mesh: node.mesh === undefined ? null : readMesh(json, bin, node.mesh),
    attributes: x.attributes,
    provenance: x.provenance,
  };
  if (x.subject === true) feature.subject = true;
  return feature;
}

export function decodeSiteContextGlb(bytes: Uint8Array): SiteContextDocument {
  const { json, bin } = readChunks(bytes);
  const meta = json.asset.extras?.[EXTRAS_KEY];
  if (!meta) throw new SiteContextFormatError(`GLB has no asset.extras.${EXTRAS_KEY}; it is not a site-context file`);
  if (meta.formatVersion !== SITE_CONTEXT_FORMAT_VERSION) {
    throw new SiteContextFormatError(`site-context format version ${meta.formatVersion} is not supported (this reader: ${SITE_CONTEXT_FORMAT_VERSION})`);
  }
  const nodes = json.nodes ?? [];
  const layers: SiteContextLayer[] = meta.layers.map((l) => {
    const group = nodes[l.node];
    if (!group) throw new SiteContextFormatError(`layer "${l.kind}" points at node ${l.node}, which the file does not have`);
    const features = (group.children ?? []).map((i) => {
      if (!nodes[i]) throw new SiteContextFormatError(`layer "${l.kind}" lists node ${i}, which the file does not have`);
      return readFeature(json, bin, nodes[i], meta.origin);
    });
    const layer: SiteContextLayer = {
      kind: l.kind,
      features,
      attribution: l.attribution,
      issues: l.issues,
      complete: l.complete,
    };
    if (l.provenance) layer.provenance = l.provenance;
    return layer;
  });
  return { crs: meta.crs, verticalCrs: meta.verticalCrs, origin: meta.origin, ...(meta.originHeight ? { originHeight: meta.originHeight } : {}), layers };
}
