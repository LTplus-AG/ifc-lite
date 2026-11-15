/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn decoded glTF tile content into one mesh per feature (batch id) in the
 * tileset root frame. Transform order per 3D Tiles 1.0/1.1: glTF node
 * hierarchy, then y-up to z-up, then RTC_CENTER / CESIUM_RTC, then the
 * composed tile transform.
 */

import { type Mat4, Y_UP_TO_Z_UP, IDENTITY, multiply, nodeMatrix, normalMatrix, translation } from '../matrix.js';
import type { TileProvenance } from '../traverse.js';
import { type DracoLoader, decodeDracoPrimitive } from './draco.js';
import { bufferViewBytes, type Gltf, type GltfPrimitive, readAccessor } from './gltf.js';

/** One primitive's triangle range inside a feature mesh, so callers can tell primitives (e.g. wall vs roof material) apart. */
export interface PrimitiveGroup {
  /** First index into `FeatureMesh.indices` and the number of indices (3 per triangle). */
  start: number;
  count: number;
  node: number;
  mesh: number;
  primitive: number;
  material?: number;
  materialName?: string;
  baseColorFactor?: [number, number, number, number];
}

export interface FeatureMesh {
  /** Batch id (b3dm `_BATCHID`) or EXT_mesh_features feature id; null when the content has none. */
  featureId: number | null;
  /**
   * Vertex positions in the tileset root frame, metres, float64: ECEF (WGS84)
   * for a georeferenced tileset. No height datum is interpreted or converted.
   */
  positions: Float64Array;
  /** Unit normals in the same frame, when the content has them. */
  normals?: Float32Array;
  indices: Uint32Array;
  groups: PrimitiveGroup[];
  /** Batch table values for this feature (absent columns are absent keys). */
  attributes: Record<string, unknown>;
  tile: TileProvenance;
}

export interface BuildContext {
  tile: TileProvenance;
  /** Composed tile transform (tile -> root). */
  tileTransform: Mat4;
  /** b3dm RTC_CENTER; glTF CESIUM_RTC is read from the document. */
  rtcCenter?: [number, number, number];
  attributes?: Array<Record<string, unknown>>;
  loadDraco: DracoLoader;
  warn(message: string): void;
}

/** Extensions whose presence changes nothing about the geometry this reader extracts. */
const HANDLED = new Set(['KHR_draco_mesh_compression', 'KHR_mesh_quantization', 'CESIUM_RTC', 'KHR_texture_transform', 'EXT_mesh_features', 'EXT_structural_metadata', 'KHR_materials_unlit']);

interface Builder {
  positions: number[];
  normals: number[];
  indices: number[];
  groups: PrimitiveGroup[];
  /** Set once any primitive of the feature lacks normals: normals are then dropped for the whole feature. */
  partialNormals: boolean;
}

interface PrimitiveData {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  featureIds?: ArrayLike<number>;
  vertexCount: number;
  indices: ArrayLike<number>;
}

function featureIdSemantic(prim: GltfPrimitive, ctx: BuildContext): string | undefined {
  if ('_BATCHID' in prim.attributes) return '_BATCHID';
  if ('BATCHID' in prim.attributes) return 'BATCHID';
  const ext = prim.extensions?.EXT_mesh_features as { featureIds?: Array<{ attribute?: number; texture?: unknown }> } | undefined;
  const first = ext?.featureIds?.[0];
  if (first) {
    if (typeof first.attribute === 'number') return `_FEATURE_ID_${first.attribute}`;
    ctx.warn(first.texture ? 'EXT_mesh_features texture feature ids are not supported; primitive has no feature ids' : 'EXT_mesh_features implicit (per-vertex) feature ids are not supported; primitive has no feature ids');
  }
  return undefined;
}

async function primitiveData(gltf: Gltf, prim: GltfPrimitive, ctx: BuildContext): Promise<PrimitiveData> {
  const fidSemantic = featureIdSemantic(prim, ctx);
  const draco = prim.extensions?.KHR_draco_mesh_compression as { bufferView: number; attributes: Record<string, number> } | undefined;
  if (draco) {
    const wanted: Record<string, number> = {};
    for (const s of ['POSITION', 'NORMAL', fidSemantic]) if (s && draco.attributes[s] !== undefined) wanted[s] = draco.attributes[s];
    const decoded = decodeDracoPrimitive(await ctx.loadDraco(), bufferViewBytes(gltf, draco.bufferView), wanted);
    const pos = decoded.attributes.get('POSITION');
    if (!pos) throw new Error('Draco primitive has no POSITION');
    // A batch id stored outside the Draco payload is still a plain accessor.
    let featureIds: ArrayLike<number> | undefined = fidSemantic ? decoded.attributes.get(fidSemantic)?.values : undefined;
    if (fidSemantic && !featureIds && prim.attributes[fidSemantic] !== undefined) featureIds = readAccessor(gltf, prim.attributes[fidSemantic]).values;
    return { positions: pos.values, normals: decoded.attributes.get('NORMAL')?.values, featureIds, vertexCount: decoded.pointCount, indices: decoded.indices };
  }
  if (prim.attributes.POSITION === undefined) throw new Error('primitive has no POSITION');
  const pos = readAccessor(gltf, prim.attributes.POSITION);
  const normals = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, prim.attributes.NORMAL).values : undefined;
  const featureIds = fidSemantic && prim.attributes[fidSemantic] !== undefined ? readAccessor(gltf, prim.attributes[fidSemantic]).values : undefined;
  const indices = prim.indices !== undefined ? readAccessor(gltf, prim.indices).values : Array.from({ length: pos.count }, (_, i) => i);
  return { positions: pos.values, normals, featureIds, vertexCount: pos.count, indices };
}

/** Triangle list from TRIANGLES (4) / TRIANGLE_STRIP (5) / TRIANGLE_FAN (6). */
function triangleList(mode: number, idx: ArrayLike<number>): ArrayLike<number> {
  if (mode === 4) return idx;
  const out: number[] = [];
  if (mode === 5) {
    for (let i = 0; i + 2 < idx.length; i++) {
      if (i % 2 === 0) out.push(idx[i], idx[i + 1], idx[i + 2]);
      else out.push(idx[i + 1], idx[i], idx[i + 2]);
    }
    return out;
  }
  if (mode === 6) {
    for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  }
  return out;
}

/** Scene nodes with their world matrices; iterative, each node visited once. */
function sceneNodes(gltf: Gltf): Array<[number, number[]]> {
  const nodes = gltf.json.nodes ?? [];
  const roots = gltf.json.scenes?.[gltf.json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const out: Array<[number, number[]]> = [];
  const seen = new Set<number>();
  const stack: Array<[number, Mat4]> = roots.map((r) => [r, IDENTITY] as [number, Mat4]).reverse();
  while (stack.length) {
    const [i, parent] = stack.pop()!;
    const node = nodes[i];
    if (!node || seen.has(i)) continue;
    seen.add(i);
    const world = multiply(parent, nodeMatrix(node));
    out.push([i, world]);
    for (const c of [...(node.children ?? [])].reverse()) stack.push([c, world]);
  }
  return out;
}

export async function buildFeatureMeshes(gltf: Gltf, ctx: BuildContext): Promise<FeatureMesh[]> {
  for (const ext of gltf.json.extensionsRequired ?? []) {
    if (!HANDLED.has(ext) && !ext.startsWith('KHR_materials_')) throw new Error(`glTF requires unsupported extension ${ext}`);
  }
  if (gltf.json.extensionsUsed?.includes('EXT_structural_metadata')) {
    ctx.warn('EXT_structural_metadata property tables are not read; features carry no 3D Tiles 1.1 metadata properties');
  }
  const cesiumRtc = (gltf.json.extensions?.CESIUM_RTC as { center?: number[] } | undefined)?.center;
  const rtc = ctx.rtcCenter ?? (cesiumRtc && cesiumRtc.length === 3 ? (cesiumRtc as [number, number, number]) : undefined);
  if (ctx.rtcCenter && cesiumRtc) ctx.warn('both RTC_CENTER and CESIUM_RTC present; using RTC_CENTER');
  let base = ctx.tileTransform;
  if (rtc) base = multiply(base, translation(rtc[0], rtc[1], rtc[2]));
  base = multiply(base, Y_UP_TO_Z_UP);

  const features = new Map<number | null, Builder>();
  const builderFor = (fid: number | null): Builder => {
    let b = features.get(fid);
    if (!b) features.set(fid, (b = { positions: [], normals: [], indices: [], groups: [], partialNormals: false }));
    return b;
  };

  for (const [nodeIndex, world] of sceneNodes(gltf)) {
    const meshIndex = gltf.json.nodes?.[nodeIndex]?.mesh;
    if (meshIndex === undefined) continue;
    const mesh = gltf.json.meshes?.[meshIndex];
    if (!mesh) continue;
    const m = multiply(base, world);
    const nm = normalMatrix(m);
    for (let p = 0; p < mesh.primitives.length; p++) {
      const prim = mesh.primitives[p];
      const mode = prim.mode ?? 4;
      if (mode < 4 || mode > 6) {
        ctx.warn(`mesh ${meshIndex} primitive ${p}: mode ${prim.mode} (points/lines) skipped`);
        continue;
      }
      const data = await primitiveData(gltf, prim, ctx);
      appendPrimitive(data, triangleList(mode, data.indices), m, nm, builderFor, {
        node: nodeIndex, mesh: meshIndex, primitive: p, ...materialTag(gltf, prim.material),
      });
    }
  }

  const out: FeatureMesh[] = [];
  for (const [fid, b] of features) {
    const attrs = fid !== null && ctx.attributes ? ctx.attributes[fid] : undefined;
    if (fid !== null && ctx.attributes && !attrs) ctx.warn(`feature id ${fid} has no batch table row`);
    out.push({
      featureId: fid,
      positions: Float64Array.from(b.positions),
      normals: !b.partialNormals && b.normals.length ? Float32Array.from(b.normals) : undefined,
      indices: Uint32Array.from(b.indices),
      groups: b.groups,
      attributes: attrs ? { ...attrs } : {},
      tile: ctx.tile,
    });
  }
  out.sort((a, b) => (a.featureId ?? -1) - (b.featureId ?? -1));
  return out;
}

function materialTag(gltf: Gltf, material: number | undefined): Partial<PrimitiveGroup> {
  if (material === undefined) return {};
  const mat = gltf.json.materials?.[material];
  const f = mat?.pbrMetallicRoughness?.baseColorFactor;
  return {
    material,
    materialName: mat?.name,
    baseColorFactor: f && f.length === 4 ? [f[0], f[1], f[2], f[3]] : undefined,
  };
}

function appendPrimitive(
  data: PrimitiveData,
  tris: ArrayLike<number>,
  m: Mat4,
  nm: number[] | null,
  builderFor: (fid: number | null) => Builder,
  tag: Omit<PrimitiveGroup, 'start' | 'count'>,
): void {
  const { positions: P, normals: N, featureIds: F, vertexCount } = data;
  const hasNormals = N !== undefined && nm !== null;
  // Per-primitive vertex remap; a vertex shared by triangles of two features is copied into each.
  const remap = new Map<number | null, Int32Array>();
  const open = new Map<Builder, number>();
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const fid = F ? Math.round(F[tris[t]]) : null;
    const b = builderFor(fid);
    if (!open.has(b)) {
      open.set(b, b.indices.length);
      if (!hasNormals) b.partialNormals = true;
    }
    let map = remap.get(fid);
    if (!map) remap.set(fid, (map = new Int32Array(vertexCount).fill(-1)));
    for (let k = 0; k < 3; k++) {
      const v = tris[t + k];
      if (v >= vertexCount) throw new Error(`index ${v} out of range (${vertexCount} vertices)`);
      let local = map[v];
      if (local < 0) {
        local = b.positions.length / 3;
        map[v] = local;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
        b.positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        if (hasNormals) {
          const nx = N![v * 3], ny = N![v * 3 + 1], nz = N![v * 3 + 2];
          const ox = nm![0] * nx + nm![3] * ny + nm![6] * nz;
          const oy = nm![1] * nx + nm![4] * ny + nm![7] * nz;
          const oz = nm![2] * nx + nm![5] * ny + nm![8] * nz;
          const len = Math.hypot(ox, oy, oz) || 1;
          b.normals.push(ox / len, oy / len, oz / len);
        }
      }
      b.indices.push(local);
    }
  }
  for (const [b, start] of open) b.groups.push({ start, count: b.indices.length - start, ...tag });
}
