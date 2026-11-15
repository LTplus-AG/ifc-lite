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
import { isCount } from '../bytes.js';
import { type ContentBudget, invalid } from '../limits.js';
import type { TileProvenance } from '../traverse.js';
import { type DracoLoader, decodeDracoPrimitive } from './draco.js';
import { accessorCount, bufferViewBytes, type Gltf, type GltfPrimitive, readAccessor, readIndices } from './gltf.js';

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
  /** Batch table row of a batch id (b3dm); undefined when the id has no row. */
  attributes?: (batchId: number) => Record<string, unknown> | undefined;
  loadDraco: DracoLoader;
  /** Decoded vertex/index budget of this content; charged before anything is decoded. */
  budget: ContentBudget;
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
  /** Triangle list (mode already applied). */
  triangles: Uint32Array;
}

function featureIdSemantic(prim: GltfPrimitive, ctx: BuildContext): string | undefined {
  if (Object.hasOwn(prim.attributes, '_BATCHID')) return '_BATCHID';
  if (Object.hasOwn(prim.attributes, 'BATCHID')) return 'BATCHID';
  const ext = prim.extensions?.EXT_mesh_features as { featureIds?: Array<{ attribute?: number; texture?: unknown }> } | undefined;
  const first = Array.isArray(ext?.featureIds) ? ext.featureIds[0] : undefined;
  if (first) {
    if (isCount(first.attribute)) return `_FEATURE_ID_${first.attribute}`;
    ctx.warn(first.texture ? 'EXT_mesh_features texture feature ids are not supported; primitive has no feature ids' : 'EXT_mesh_features implicit (per-vertex) feature ids are not supported; primitive has no feature ids');
  }
  return undefined;
}

function attributeIndex(prim: GltfPrimitive, semantic: string | undefined): number | undefined {
  return semantic !== undefined && Object.hasOwn(prim.attributes, semantic) ? prim.attributes[semantic] : undefined;
}

/** Number of triangle-list indices a primitive with `n` indices in `mode` yields. */
function triangleIndexCount(mode: number, n: number): number {
  if (mode === 4) return n - (n % 3);
  return n >= 3 ? (n - 2) * 3 : 0;
}

/** Triangle list from TRIANGLES (4) / TRIANGLE_STRIP (5) / TRIANGLE_FAN (6). */
function triangleList(mode: number, idx: Uint32Array): Uint32Array {
  if (mode === 4) return idx.length % 3 === 0 ? idx : idx.subarray(0, idx.length - (idx.length % 3));
  const out = new Uint32Array(triangleIndexCount(mode, idx.length));
  let o = 0;
  if (mode === 5) {
    for (let i = 0; i + 2 < idx.length; i++) {
      if (i % 2 === 0) { out[o++] = idx[i]; out[o++] = idx[i + 1]; out[o++] = idx[i + 2]; }
      else { out[o++] = idx[i + 1]; out[o++] = idx[i]; out[o++] = idx[i + 2]; }
    }
  } else {
    for (let i = 1; i + 1 < idx.length; i++) { out[o++] = idx[0]; out[o++] = idx[i]; out[o++] = idx[i + 1]; }
  }
  return out;
}

function sequence(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Declared vertex and triangle-index counts of a primitive, from its glTF
 * accessors alone (Draco primitives declare them too), so the content budget
 * is charged before anything is decoded or allocated.
 */
function declaredCounts(gltf: Gltf, prim: GltfPrimitive, mode: number, budget: ContentBudget): { vertices: number; indices: number } {
  const posIndex = attributeIndex(prim, 'POSITION');
  if (posIndex === undefined) throw invalid('primitive has no POSITION');
  const vertices = accessorCount(gltf, posIndex, { maxCount: budget.maxVertices, what: 'POSITION' });
  const n = prim.indices !== undefined ? accessorCount(gltf, prim.indices, { maxCount: budget.maxIndices, what: 'indices' }) : vertices;
  return { vertices, indices: triangleIndexCount(mode, n) };
}

async function primitiveData(gltf: Gltf, prim: GltfPrimitive, mode: number, declared: { vertices: number }, ctx: BuildContext): Promise<PrimitiveData> {
  const fidSemantic = featureIdSemantic(prim, ctx);
  const draco = prim.extensions?.KHR_draco_mesh_compression as { bufferView: number; attributes: Record<string, number> } | undefined;
  const vertexAccessor = (semantic: string, types: string[]): Float64Array | undefined => {
    const index = attributeIndex(prim, semantic);
    if (index === undefined) return undefined;
    const acc = readAccessor(gltf, index, { maxCount: ctx.budget.maxVertices, types, what: semantic });
    if (acc.count !== declared.vertices) throw invalid(`${semantic} has ${acc.count} elements for ${declared.vertices} vertices`);
    return acc.values;
  };
  if (draco) {
    if (!draco.attributes || typeof draco.attributes !== 'object') throw invalid('KHR_draco_mesh_compression has no attributes');
    const wanted: Record<string, number> = {};
    for (const s of ['POSITION', 'NORMAL', fidSemantic]) if (s && Object.hasOwn(draco.attributes, s) && isCount(draco.attributes[s])) wanted[s] = draco.attributes[s];
    const maxIndices = prim.indices !== undefined ? accessorCount(gltf, prim.indices, { maxCount: ctx.budget.maxIndices, what: 'indices' }) : ctx.budget.maxIndices;
    const decoded = decodeDracoPrimitive(await ctx.loadDraco(), bufferViewBytes(gltf, draco.bufferView), wanted, declared.vertices, maxIndices);
    const pos = decoded.attributes.get('POSITION');
    if (!pos) throw invalid('Draco primitive has no POSITION');
    // A batch id stored outside the Draco payload is still a plain accessor.
    let featureIds: ArrayLike<number> | undefined = fidSemantic ? decoded.attributes.get(fidSemantic)?.values : undefined;
    if (fidSemantic && !featureIds && attributeIndex(prim, fidSemantic) !== undefined) {
      featureIds = readAccessor(gltf, prim.attributes[fidSemantic], { maxCount: ctx.budget.maxVertices, types: ['SCALAR'], what: fidSemantic }).values;
      if (featureIds.length !== decoded.pointCount) throw invalid(`${fidSemantic} has ${featureIds.length} elements for ${decoded.pointCount} vertices`);
    }
    return { positions: pos.values, normals: decoded.attributes.get('NORMAL')?.values, featureIds, vertexCount: decoded.pointCount, triangles: triangleList(mode, decoded.indices) };
  }
  const positions = vertexAccessor('POSITION', ['VEC3'])!;
  const normals = vertexAccessor('NORMAL', ['VEC3']);
  const featureIds = vertexAccessor(fidSemantic ?? '', ['SCALAR']);
  // No indices: vertices are drawn in order. Built as a typed array from the validated count.
  const indices = prim.indices !== undefined ? readIndices(gltf, prim.indices, ctx.budget.maxIndices) : sequence(declared.vertices);
  return { positions, normals, featureIds, vertexCount: declared.vertices, triangles: triangleList(mode, indices) };
}

/**
 * Scene nodes with their world matrices; iterative, each node visited once.
 * Without a usable scene, the roots are the nodes no other node lists as a
 * child, so a child listed before its parent still gets the parent transform.
 */
function sceneNodes(gltf: Gltf): Array<[number, number[]]> {
  const nodes = Array.isArray(gltf.json.nodes) ? gltf.json.nodes : [];
  const childList = (i: number): number[] => {
    const c = nodes[i]?.children;
    return Array.isArray(c) ? c.filter((x): x is number => isCount(x) && x < nodes.length) : [];
  };
  let roots = gltf.json.scenes?.[gltf.json.scene ?? 0]?.nodes;
  if (!Array.isArray(roots)) {
    const isChild = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) for (const c of childList(i)) isChild[c] = 1;
    roots = [];
    for (let i = 0; i < nodes.length; i++) if (!isChild[i]) roots.push(i);
  }
  const out: Array<[number, number[]]> = [];
  const seen = new Set<number>();
  const stack: Array<[number, Mat4]> = roots.filter(isCount).map((r) => [r, IDENTITY] as [number, Mat4]).reverse();
  while (stack.length) {
    const [i, parent] = stack.pop()!;
    const node = nodes[i];
    if (!node || seen.has(i)) continue;
    seen.add(i);
    const world = multiply(parent, nodeMatrix(node));
    out.push([i, world]);
    const children = childList(i);
    for (let k = children.length - 1; k >= 0; k--) stack.push([children[k], world]);
  }
  return out;
}

export async function buildFeatureMeshes(gltf: Gltf, ctx: BuildContext): Promise<FeatureMesh[]> {
  const required = Array.isArray(gltf.json.extensionsRequired) ? gltf.json.extensionsRequired : [];
  for (const ext of required) {
    if (typeof ext !== 'string' || (!HANDLED.has(ext) && !ext.startsWith('KHR_materials_'))) throw new Error(`glTF requires unsupported extension ${String(ext)}`);
  }
  if (Array.isArray(gltf.json.extensionsUsed) && gltf.json.extensionsUsed.includes('EXT_structural_metadata')) {
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

  // A mesh used by several nodes is decoded once and appended per node; each instance is charged to the budget.
  const decodedPrimitives = new Map<string, PrimitiveData>();
  for (const [nodeIndex, world] of sceneNodes(gltf)) {
    const meshIndex = gltf.json.nodes?.[nodeIndex]?.mesh;
    if (!isCount(meshIndex)) continue;
    const mesh = gltf.json.meshes?.[meshIndex];
    if (!mesh || !Array.isArray(mesh.primitives)) continue;
    const m = multiply(base, world);
    const nm = normalMatrix(m);
    for (let p = 0; p < mesh.primitives.length; p++) {
      const prim = mesh.primitives[p];
      if (!prim || typeof prim !== 'object' || !prim.attributes || typeof prim.attributes !== 'object') throw invalid(`mesh ${meshIndex} primitive ${p} has no attributes`);
      const mode = prim.mode ?? 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) {
        ctx.warn(`mesh ${meshIndex} primitive ${p}: mode ${prim.mode} (points/lines) skipped`);
        continue;
      }
      const declared = declaredCounts(gltf, prim, mode, ctx.budget);
      ctx.budget.charge(declared.vertices, declared.indices, `mesh ${meshIndex} primitive ${p}`);
      const key = `${meshIndex}/${p}`;
      let data = decodedPrimitives.get(key);
      if (!data) decodedPrimitives.set(key, (data = await primitiveData(gltf, prim, mode, declared, ctx)));
      appendPrimitive(data, m, nm, builderFor, {
        node: nodeIndex, mesh: meshIndex, primitive: p, ...materialTag(gltf, prim.material),
      });
    }
  }

  const out: FeatureMesh[] = [];
  for (const [fid, b] of features) {
    const attrs = fid !== null && ctx.attributes ? ctx.attributes(fid) : undefined;
    if (fid !== null && ctx.attributes && !attrs) ctx.warn(`feature id ${fid} has no batch table row`);
    out.push({
      featureId: fid,
      positions: Float64Array.from(b.positions),
      normals: !b.partialNormals && b.normals.length ? Float32Array.from(b.normals) : undefined,
      indices: Uint32Array.from(b.indices),
      groups: b.groups,
      attributes: attrs ?? {},
      tile: ctx.tile,
    });
  }
  out.sort((a, b) => (a.featureId ?? -1) - (b.featureId ?? -1));
  return out;
}

function materialTag(gltf: Gltf, material: number | undefined): Partial<PrimitiveGroup> {
  if (!isCount(material)) return {};
  const mat = gltf.json.materials?.[material];
  const f = mat?.pbrMetallicRoughness?.baseColorFactor;
  return {
    material,
    materialName: mat?.name,
    baseColorFactor: f && f.length === 4 ? [f[0], f[1], f[2], f[3]] : undefined,
  };
}

/**
 * Append one primitive instance to the feature builders. One pass with memory
 * linear in vertices: `owner[v]` is the first feature that used vertex v and
 * `local[v]` its index there; only a vertex that a second feature also uses
 * gets a map entry for that feature, and is copied into it.
 */
function appendPrimitive(
  data: PrimitiveData,
  m: Mat4,
  nm: number[] | null,
  builderFor: (fid: number | null) => Builder,
  tag: Omit<PrimitiveGroup, 'start' | 'count'>,
): void {
  const { positions: P, normals: N, featureIds: F, vertexCount, triangles: tris } = data;
  const hasNormals = N !== undefined && nm !== null;
  const owner = new Int32Array(vertexCount).fill(-1);
  const local = new Int32Array(vertexCount);
  const slots: Builder[] = [];
  const slotOf = new Map<Builder, number>();
  const sharedBySlot = new Map<number, Map<number, number>>();
  const starts: number[] = [];
  const emit = (b: Builder, v: number): number => {
    const index = b.positions.length / 3;
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
    return index;
  };
  for (let t = 0; t + 2 < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      if (tris[t + k] >= vertexCount) throw invalid(`index ${tris[t + k]} out of range (${vertexCount} vertices)`);
    }
    const raw = F ? F[tris[t]] : undefined;
    const fid = raw === undefined ? null : Number.isFinite(raw) ? Math.round(raw) : null;
    const b = builderFor(fid);
    let slot = slotOf.get(b);
    if (slot === undefined) {
      slot = slots.length;
      slots.push(b);
      slotOf.set(b, slot);
      starts.push(b.indices.length);
      if (!hasNormals) b.partialNormals = true;
    }
    for (let k = 0; k < 3; k++) {
      const v = tris[t + k];
      let index: number;
      if (owner[v] === -1) {
        owner[v] = slot;
        index = local[v] = emit(b, v);
      } else if (owner[v] === slot) {
        index = local[v];
      } else {
        let shared = sharedBySlot.get(slot);
        if (!shared) sharedBySlot.set(slot, (shared = new Map()));
        let s = shared.get(v);
        if (s === undefined) shared.set(v, (s = emit(b, v)));
        index = s;
      }
      b.indices.push(index);
    }
  }
  for (let i = 0; i < slots.length; i++) slots[i].groups.push({ start: starts[i], count: slots[i].indices.length - starts[i], ...tag });
}
