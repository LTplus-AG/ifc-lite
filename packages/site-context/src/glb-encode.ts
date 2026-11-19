/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `encodeSiteContextGlb`: one self-describing GLB per site-context document (format in `glb-format.ts`). */

import {
  ARRAY_BUFFER,
  AXES_DESCRIPTION,
  CHUNK_BIN,
  CHUNK_JSON,
  ELEMENT_ARRAY_BUFFER,
  EXTRAS_KEY,
  FLOAT,
  GLB_MAGIC,
  LAYER_MATERIALS,
  SITE_CONTEXT_FORMAT_VERSION,
  UNSIGNED_INT,
  type GltfAccessor,
  type GltfJson,
  type GltfNode,
  type SiteContextGlbMeta,
  type SiteContextGlbNodeExtras,
} from './glb-format.js';
import type { SiteContextDocument, SiteContextLayerKind, SiteContextMesh } from './types.js';

/** Site frame (east, north, up) → glTF (east, up, −north). Exact. */
function toGltfAxes(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    out[i] = src[i];
    out[i + 1] = src[i + 2];
    out[i + 2] = -src[i + 1];
  }
  return out;
}

class BinWriter {
  readonly parts: Uint8Array[] = [];
  length = 0;
  readonly views: NonNullable<GltfJson['bufferViews']> = [];
  readonly accessors: GltfAccessor[] = [];

  add(data: Float32Array | Uint32Array, target: number, type: GltfAccessor['type'], minMax: boolean): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, target });
    this.parts.push(bytes);
    this.length += bytes.byteLength; // always a multiple of 4
    const width = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
    const accessor: GltfAccessor = {
      bufferView: this.views.length - 1,
      componentType: data instanceof Float32Array ? FLOAT : UNSIGNED_INT,
      count: data.length / width,
      type,
    };
    if (minMax) {
      const min = new Array<number>(width).fill(Infinity);
      const max = new Array<number>(width).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const k = i % width;
        if (data[i] < min[k]) min[k] = data[i];
        if (data[i] > max[k]) max[k] = data[i];
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }
}

function addMesh(bin: BinWriter, mesh: SiteContextMesh, material: number) {
  const attributes: { POSITION: number; NORMAL: number; TEXCOORD_0?: number } = {
    POSITION: bin.add(toGltfAxes(mesh.positions), ARRAY_BUFFER, 'VEC3', true),
    NORMAL: bin.add(toGltfAxes(mesh.normals), ARRAY_BUFFER, 'VEC3', false),
  };
  if (mesh.uvs) attributes.TEXCOORD_0 = bin.add(mesh.uvs, ARRAY_BUFFER, 'VEC2', false);
  const indices = bin.add(mesh.indices, ELEMENT_ARRAY_BUFFER, 'SCALAR', false);
  const out: NonNullable<GltfJson['meshes']>[number] = { primitives: [{ attributes, indices, material, mode: 4 }] };
  // Parts stay index ranges of the one primitive, so a reader that ignores them still gets the whole mesh.
  if (mesh.parts) out.extras = { [EXTRAS_KEY]: { parts: mesh.parts.map((p) => ({ name: p.name, firstIndex: p.firstIndex, indexCount: p.indexCount })) } };
  return out;
}

function pad(bytes: Uint8Array, fill: number): Uint8Array {
  const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4).fill(fill);
  padded.set(bytes);
  return padded;
}

export function encodeSiteContextGlb(doc: SiteContextDocument): Uint8Array {
  const bin = new BinWriter();
  const nodes: GltfNode[] = [{ name: 'site-context', children: [] }];
  const meshes: NonNullable<GltfJson['meshes']> = [];
  const materials: unknown[] = [];
  const materialIndex = new Map<SiteContextLayerKind, number>();
  const meta: SiteContextGlbMeta = {
    formatVersion: SITE_CONTEXT_FORMAT_VERSION,
    crs: doc.crs,
    verticalCrs: doc.verticalCrs,
    origin: [...doc.origin],
    ...(doc.originHeight ? { originHeight: { ...doc.originHeight } } : {}),
    axes: AXES_DESCRIPTION,
    layers: [],
  };
  const [e0, n0, h0] = doc.origin;
  for (const layer of doc.layers) {
    const layerNode = nodes.length;
    const group: GltfNode = { name: layer.kind, children: [] };
    nodes.push(group);
    nodes[0].children!.push(layerNode);
    meta.layers.push({
      kind: layer.kind,
      attribution: layer.attribution,
      issues: layer.issues,
      complete: layer.complete,
      node: layerNode,
      ...(layer.provenance ? { provenance: layer.provenance } : {}),
    });
    for (const f of layer.features) {
      const extras: SiteContextGlbNodeExtras = {
        id: f.id,
        ifcType: f.ifcType,
        name: f.name,
        origin: [...f.origin],
        attributes: f.attributes,
        provenance: f.provenance,
        ...(f.subject ? { subject: true as const } : {}),
      };
      const node: GltfNode = {
        name: f.name,
        translation: [f.origin[0] - e0, f.origin[2] - h0, -(f.origin[1] - n0)],
        extras: { [EXTRAS_KEY]: extras },
      };
      if (f.mesh && f.mesh.indices.length > 0) {
        let material = materialIndex.get(layer.kind);
        if (material === undefined) {
          const m = LAYER_MATERIALS[layer.kind];
          material = materials.length;
          materials.push({
            name: m.name,
            doubleSided: m.doubleSided,
            pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 1 },
          });
          materialIndex.set(layer.kind, material);
        }
        node.mesh = meshes.length;
        meshes.push({ name: f.id, ...addMesh(bin, f.mesh, material) });
      }
      group.children!.push(nodes.length);
      nodes.push(node);
    }
  }
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'ifc-lite site-context', extras: { [EXTRAS_KEY]: meta } },
    scene: 0,
    scenes: [{ name: 'site context', nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors: bin.accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: bin.length }],
  };
  if (bin.length === 0) {
    delete json.bufferViews;
    delete json.buffers;
    delete json.accessors;
  }
  // glTF 2.0 requires at least one item wherever these arrays are present: an empty layer
  // (a failed terrain read, no parcel) leaves its group node without children (#10480 review).
  if (json.meshes?.length === 0) delete json.meshes;
  if (json.materials?.length === 0) delete json.materials;
  for (const node of json.nodes ?? []) if (node.children?.length === 0) delete node.children;
  const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const binBytes = bin.length > 0 ? pad(concat(bin.parts, bin.length), 0) : null;
  const total = 12 + 8 + jsonBytes.byteLength + (binBytes ? 8 + binBytes.byteLength : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  if (binBytes) {
    const at = 20 + jsonBytes.byteLength;
    dv.setUint32(at, binBytes.byteLength, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(binBytes, at + 8);
  }
  return out;
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
