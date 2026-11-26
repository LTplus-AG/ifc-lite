/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The decisions a bucket batch's build takes, taken for compact pages: LOD1,
 * contribution culling and the exact-f32 fallback (#9068).
 *
 * A page holds the meshes of one compact cell and colour; the bucket path
 * files the same meshes by chunk cell and colour (`Scene.bucketBaseKey`), so
 * one bucket batch's meshes sit on several pages and one page holds parts of
 * several buckets. The bucket a mesh would be in is its GROUP. At the end of a
 * stream (`SceneCompact.settle`) every group is judged as its bucket batch
 * would be:
 *
 * - **Shared buckets.** A group whose bucket holds f32 meshes too (meshes no page draws) moves to it:
 *   the bucket batch is the union, and only it decides as that batch does.
 * - **Exact fallback.** A bucket batch stays exact f32 when one of its meshes
 *   would lose its shape on the 1 mm lattice (#9068) or the batch is wider
 *   than the u16 range (quantize.ts). The encoder moved such a mesh to a finer
 *   lattice level, so a group with a row finer than level 10, or wider than
 *   that range, is the group of an exact batch: `settlePages` hands its meshes
 *   to the scene, which moves them to buckets, decoded. (A row on level 9 only
 *   outgrew its window, which says nothing about its bucket's extent.)
 * - **LOD1 and culling.** Each page's index buffer is rewritten group by group
 *   (a part per group, `lod-parts.ts`), and the page gets a second index buffer
 *   holding each part's LOD1 range: the bucket clustering (lod-simplify.ts)
 *   over the page's own records, with the cell size the group's box gives.
 *   Whether a group gets LOD1 at all is decided over all its parts, as for one
 *   batch. The draw loop then culls and picks LOD per part on the group's box.
 *
 * Only indices are written: positions are read from the records into a
 * per-page scratch that is reused, and no f32 copy of any mesh is kept.
 * Clustering is per page, so two meshes of one entity in one group but on
 * different pages do not share a cell's vertex (the bucket path's would).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { COMPACT_RECORD_BYTES, compactRow } from '@ifc-lite/geometry/compact';
import type { CompactPageDeps } from './compact-page-deps.js';
import type { CompactGeometryStore, CompactPage } from './compact-store.js';
import type { LodPart } from './lod-parts.js';
import type { SceneCompactHost } from './scene-compact-host.js';
import { bucketKeyOf, collectGroups, type Group } from './compact-groups.js';
import { lod1Vertices } from './compact-lod-vertices.js';

/** Scratch record per vertex: position xyz (page frame) and the u32 entity lane. */
const SCRATCH_FLOATS = 4;
/** Vertices a page holds at most: every page draws with u16 indices (compact-store.ts). */
export const MAX_PAGE_VERTICES = 65536;

/** A page's LOD state: where each entity's LOD1 triangles are, so a retired entity's can be emptied. */
export interface PageLod {
  /** Entity id -> its [start, count] ranges in the page's LOD1 index buffer (one per part it is in). */
  ranges: Map<number, Array<[number, number]>>;
  bytes: number;
}

/**
 * The pages were trimmed at the end of a stream (or changed by an edit, `retired`): hand the meshes of every group whose bucket batch would
 * stay exact f32, or whose bucket holds f32 meshes too, to `toBuckets` now (they join the stream's finalize), and return the build of the pages'
 * parts when bucket batches build LOD1 (null otherwise). The caller runs it a slice at a time and drops it
 * when the pages change under it.
 */
export function settlePages(
  store: CompactGeometryStore, host: SceneCompactHost, device: GPUDevice, deps: CompactPageDeps,
  toBuckets: (meshes: MeshData[], reason: 'exact' | 'shared') => void,
  /** An edit-time build, for meshes that left their pages: only the pages holding their groups are built again
   *  ('all': every page), and no group moves to its bucket (an edit of one element does not decode its group). */
  retired?: ReadonlySet<MeshData> | 'all',
): PageLodBuild | null {
  const t0 = performance.now();
  const groups = collectGroups(store, host, deps, !retired);
  const keys = retired && retired !== 'all' ? new Set([...retired].map((mesh) => bucketKeyOf(host, mesh, true))) : undefined;
  // A retired mesh no build saw (no cached key): every page is built again.
  const only = keys && !keys.has(undefined) ? keys : undefined;
  if (!retired) for (const reason of ['exact', 'shared'] as const) {
    const meshes: MeshData[] = [];
    for (const group of groups.values()) if (group.move === reason) meshes.push(...group.members);
    if (meshes.length > 0) toBuckets(meshes, reason);
  }
  store.stats.settleMs += performance.now() - t0;
  return host.lodBuildsEnabled ? new PageLodBuild(store, buildPageLods(store, groups, device, deps, only && affectedPages(store, host, only))) : null;
}

/**
 * The pages to build again for groups `keys`: every page holding a part of one, and (a group's decision
 * needs all its parts) every page holding a part of any other group on those pages, to a fixpoint.
 */
function affectedPages(store: CompactGeometryStore, host: SceneCompactHost, keys: ReadonlySet<string | undefined>): (page: CompactPage) => boolean {
  const pageKeys = new Map<CompactPage, Set<string | undefined>>();
  for (const page of store.pageList()) pageKeys.set(page, new Set([...page.meshes].map((mesh) => bucketKeyOf(host, mesh, true))));
  const groups = new Set(keys), pages = new Set<CompactPage>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [page, own] of pageKeys) {
      if (pages.has(page) || ![...own].some((key) => groups.has(key))) continue;
      pages.add(page);
      for (const key of own) groups.add(key);
      grew = true;
    }
  }
  return (page) => pages.has(page);
}

/**
 * The pages' LOD build, one page per step: clustering every page first (a group's decision needs all its
 * parts), then installing them. A page draws whole until its step installs its parts.
 */
export class PageLodBuild {
  constructor(private readonly store: CompactGeometryStore, private readonly steps: Iterator<void>) {}

  /** Run steps until `budgetMs` has passed (at least one); returns whether the build finished. */
  step(budgetMs: number): boolean {
    const t0 = performance.now(), end = t0 + budgetMs;
    let done = false;
    do done = this.steps.next().done === true; while (!done && performance.now() < end);
    this.store.stats.settleMs += performance.now() - t0;
    return done;
  }
}

/** One entity's run of a part's LOD1 triangles: [from, to) in the part's LOD1 indices. */
interface EntityRun { from: number; to: number; id: number }

/** A page's meshes per group, each sorted by entity (an entity's LOD1 triangles are then one run). */
interface PagePlan {
  page: CompactPage;
  /** `lod1` indexes the part's own representative `records` (compact-lod-vertices.ts). */
  parts: Array<{ group: Group; meshes: MeshData[]; lod1: Uint16Array | null; records: Uint8Array | null; runs: EntityRun[] }>;
}

/**
 * Rewrite every page's index buffer by group and give it each group's LOD1 range. `groups` is what
 * `collectGroups` returned for the pages; the meshes of an exact group that left them since are skipped (no
 * group decision changes: a group that moves gets no LOD1, nor do the meshes of it a bucket refused).
 */
function* buildPageLods(
  store: CompactGeometryStore, groups: Map<string, Group>, device: GPUDevice, deps: CompactPageDeps, pages?: (page: CompactPage) => boolean,
): Generator<void, void, void> {
  const { simplify, lodCellSize, lodMinTriangles, lodMaxKeptFraction } = deps.bucket;
  const groupOf = new Map<MeshData, Group>();
  for (const group of groups.values()) for (const mesh of group.members) groupOf.set(mesh, group);
  // Allocated by the first page that clusters: positions and lanes, and the records' own u16 nodes.
  let scratch: Float32Array | null = null, lanes: Uint32Array | null = null, nodes: Uint16Array | null = null;
  const plans: PagePlan[] = [];
  for (const page of store.pageList()) {
    if (pages && !pages(page)) continue; // its groups are as they were: it keeps its parts
    // A page with a mesh `collect` did not see, or one written since (no records to read), keeps its own buffer, and
    // its groups get no LOD1: their other parts alone cannot be judged as the bucket would judge them.
    const byGroup = new Map<Group, MeshData[]>();
    let whole = true;
    for (const mesh of page.meshes) {
      const group = groupOf.get(mesh);
      if (!group || !mesh.compact) { whole = false; continue; }
      const list = byGroup.get(group);
      if (list) list.push(mesh); else byGroup.set(group, [mesh]);
    }
    if (!whole) for (const group of byGroup.keys()) group.kept = -1;
    if (!whole || byGroup.size === 0) continue;
    const plan: PagePlan = { page, parts: [] };
    let decoded = false;
    for (const [group, meshes] of byGroup) {
      meshes.sort((a, b) => a.expressId - b.expressId); // stable: an entity's meshes keep their order
      let lod1: Uint16Array | null = null, records: Uint8Array | null = null;
      const runs: EntityRun[] = [];
      if (!group.move && group.kept >= 0 && group.triangles >= lodMinTriangles) {
        scratch ??= new Float32Array(MAX_PAGE_VERTICES * SCRATCH_FLOATS);
        lanes ??= new Uint32Array(scratch.buffer);
        nodes ??= new Uint16Array(MAX_PAGE_VERTICES * 3);
        if (!decoded) { readRecords(store, page, scratch, lanes, nodes); decoded = true; }
        const source = sourceIndices(store, meshes);
        const out = simplify(scratch.subarray(0, page.vertexCount * SCRATCH_FLOATS), SCRATCH_FLOATS, source,
          lodCellSize(group.bounds.min, group.bounds.max), { idLaneOffset: 3, frameOrigin: store.origin!, unconditional: true });
        if (out) {
          group.kept += out.length;
          ({ indices: lod1, records } = lod1Vertices(out, source, { positions: scratch, lanes, nodes, vertexCount: page.vertexCount }, deps.bucket.octEncode));
          // The clustering is entity-scoped: every corner of a triangle carries its entity's lane.
          const idOf = new Map<number, number>();
          for (const mesh of meshes) idOf.set(lanes[store.slotOf(mesh)!.base * SCRATCH_FLOATS + 3], mesh.expressId);
          for (let from = 0; from < out.length;) {
            const lane = lanes[out[from] * SCRATCH_FLOATS + 3];
            let to = from + 3;
            while (to < out.length && lanes[out[to] * SCRATCH_FLOATS + 3] === lane) to += 3;
            runs.push({ from, to, id: idOf.get(lane) ?? -1 });
            from = to;
          }
        } else group.kept = -1;
      }
      plan.parts.push({ group, meshes, lod1, records, runs });
    }
    plans.push(plan);
    yield;
  }
  // Whether a group draws LOD1 is its batch's decision: enough triangles, and the clustering pays over all its parts.
  const pays = (group: Group): boolean => group.kept > 0 && group.kept < group.triangles * 3 * lodMaxKeptFraction;
  for (const plan of plans) for (const part of plan.parts) if (!pays(part.group)) part.lod1 = null;
  for (const plan of plans) {
    // Written since it was clustered: its records are gone, so the page stays as it is.
    if (plan.parts.every((part) => part.meshes.every((mesh) => mesh.compact && plan.page.meshes.has(mesh)))) install(store, plan, device);
    yield;
  }
}

/** Positions (page frame), lanes and u16 nodes of `page`'s records, at their page vertex numbers. */
function readRecords(store: CompactGeometryStore, page: CompactPage, scratch: Float32Array, lanes: Uint32Array, nodes: Uint16Array): void {
  const q = page.batch.quantized!;
  for (const mesh of page.meshes) {
    const slot = store.slotOf(mesh)!, ref = mesh.compact!, records = ref.payload.records;
    const view = new DataView(records.buffer, records.byteOffset + compactRow(ref).vertexStart * COMPACT_RECORD_BYTES, slot.vertexCount * COMPACT_RECORD_BYTES);
    for (let v = 0, at = 0, out = slot.base * SCRATCH_FLOATS; v < slot.vertexCount; v++, at += COMPACT_RECORD_BYTES, out += SCRATCH_FLOATS) {
      const n = (slot.base + v) * 3;
      for (let axis = 0; axis < 3; axis++) {
        nodes[n + axis] = view.getUint16(at + axis * 2, true);
        scratch[out + axis] = q.min[axis] + nodes[n + axis] * q.step;
      }
      lanes[out + 3] = view.getUint32(at + 8, true);
    }
  }
}

/** Write `mesh`'s triangles into `out` at `at`, in page vertex numbers (`base` its first); returns its index count. */
function rebase(out: Uint16Array | Uint32Array, at: number, mesh: MeshData, base: number): number {
  const { indexStart, indexCount } = compactRow(mesh.compact!), src = mesh.compact!.payload.indices;
  for (let i = 0; i < indexCount; i++) out[at + i] = src[indexStart + i] + base;
  return indexCount;
}

/** The meshes' triangles in page vertex numbers, unpadded. */
function sourceIndices(store: CompactGeometryStore, meshes: readonly MeshData[]): Uint32Array {
  let length = 0;
  for (const mesh of meshes) length += compactRow(mesh.compact!).indexCount;
  const out = new Uint32Array(length);
  let w = 0;
  for (const mesh of meshes) w += rebase(out, w, mesh, store.slotOf(mesh)!.base);
  return out;
}

/** An index count padded to an even triangle count (buffer writes are 4-byte multiples), as the store pads its meshes. */
export function padded(count: number): number {
  return count + ((count / 3) & 1 ? 3 : 0);
}

/** Write `plan`'s page: its meshes' ranges part by part, and the LOD1 runs of the parts that kept theirs. */
function install(store: CompactGeometryStore, plan: PagePlan, device: GPUDevice): void {
  let lod0Length = 0, lod1Length = 0;
  for (const part of plan.parts) {
    for (const mesh of part.meshes) lod0Length += store.slotOf(mesh)!.indexCount;
    if (part.lod1) for (const run of part.runs) lod1Length += padded(run.to - run.from);
  }
  const lod0 = new Uint16Array(lod0Length), lod1 = lod1Length > 0 ? new Uint16Array(lod1Length) : null;
  let recordBytes = 0;
  for (const part of plan.parts) if (part.lod1) recordBytes += part.records!.length;
  const records = new Uint8Array(recordBytes);
  let base = 0; // the part's first record in the page's LOD1 vertex buffer
  const starts = new Map<MeshData, number>();
  const parts: LodPart[] = [];
  const lod: PageLod = { ranges: new Map(), bytes: 0 };
  let w0 = 0, w1 = 0;
  for (const part of plan.parts) {
    const lod0Start = w0, lod1Start = w1;
    for (const mesh of part.meshes) {
      const slot = store.slotOf(mesh)!;
      starts.set(mesh, w0);
      lod0.fill(slot.base, w0 + rebase(lod0, w0, mesh, slot.base), w0 + slot.indexCount);
      w0 += slot.indexCount;
    }
    if (lod1 && part.lod1) {
      records.set(part.records!, base * COMPACT_RECORD_BYTES);
      for (const { from, to, id } of part.runs) {
        const n = padded(to - from);
        for (let i = from; i < to; i++) lod1[w1 + i - from] = part.lod1[i] + base;
        lod1.fill(part.lod1[from] + base, w1 + to - from, w1 + n);
        const ranges = lod.ranges.get(id);
        if (ranges) ranges.push([w1, n]); else lod.ranges.set(id, [[w1, n]]);
        w1 += n;
      }
      base += part.records!.length / COMPACT_RECORD_BYTES;
    }
    parts.push({ bounds: part.group.bounds, lod0Start, lod0Count: w0 - lod0Start, lod1: part.lod1 !== null, lod1Start, lod1Count: w1 - lod1Start });
  }
  replaceIndices(store, plan.page, lod0, starts, device);
  setPageLod(store, plan.page, parts, lod1 && { indices: lod1, records }, lod, device);
}

/** Replace `page`'s index buffer with `lod0` (exact size), each listed mesh's range now starting at `starts`. */
function replaceIndices(store: CompactGeometryStore, page: CompactPage, lod0: Uint16Array, starts: ReadonlyMap<MeshData, number>, device: GPUDevice): void {
  const buffer = device.createBuffer({ size: Math.max(4, lod0.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  if (lod0.length > 0) device.queue.writeBuffer(buffer, 0, lod0);
  page.batch.indexBuffer.destroy();
  page.batch.indexBuffer = buffer;
  store.stats.allocatedBytes += (lod0.length - page.indexCapacity) * 2;
  store.stats.usedBytes += (lod0.length - page.indexCount) * 2;
  page.indexCount = page.indexCapacity = page.batch.indexCount = lod0.length;
  for (const [mesh, start] of starts) store.slotOf(mesh)!.indexStart = start;
  store.version++;
}

/** Give `page` its parts and LOD1 buffer (replacing any it had). */
function setPageLod(
  store: CompactGeometryStore, page: CompactPage, parts: LodPart[], lod1: { indices: Uint16Array; records: Uint8Array } | null, lod: PageLod, device: GPUDevice,
): void {
  dropPageLod(store, page);
  if (lod1) {
    const indices = device.createBuffer({ size: Math.max(4, lod1.indices.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(indices, 0, lod1.indices);
    const vertices = device.createBuffer({ size: Math.max(4, lod1.records.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (lod1.records.length > 0) device.queue.writeBuffer(vertices, 0, lod1.records);
    page.batch.lod1IndexBuffer = indices;
    page.batch.lod1IndexCount = lod1.indices.length;
    page.batch.lod1VertexBuffer = vertices;
    lod.bytes = indices.size + vertices.size;
    store.stats.lod1Bytes += lod.bytes;
  }
  page.batch.lodParts = parts;
  page.lod = lod;
}

/** Take `page`'s parts and LOD1 buffer away: it draws as one batch, every index. */
export function dropPageLod(store: CompactGeometryStore, page: CompactPage): void {
  if (!page.lod) return;
  page.batch.lod1IndexBuffer?.destroy();
  page.batch.lod1VertexBuffer?.destroy();
  store.stats.lod1Bytes -= page.lod.bytes;
  delete page.batch.lod1IndexBuffer;
  delete page.batch.lod1VertexBuffer;
  delete page.batch.lod1IndexCount;
  delete page.batch.lodParts;
  page.lod = undefined;
}

/**
 * `retired` meshes left `page`: each entity with no mesh left on it has its LOD1 range emptied. An entity
 * that keeps a mesh there would lose that mesh's LOD1 triangles too, so the page drops its LOD instead.
 */
export function retirePageLod(store: CompactGeometryStore, page: CompactPage, retired: readonly MeshData[], device: GPUDevice): void {
  const lod = page.lod;
  if (!lod) return;
  const ids = new Set(retired.map((mesh) => mesh.expressId));
  // `page.meshes` no longer holds the retired ones: a mesh of theirs still there keeps the entity.
  for (const mesh of page.meshes) if (ids.has(mesh.expressId)) { dropPageLod(store, page); return; }
  const buffer = page.batch.lod1IndexBuffer;
  if (!buffer) return;
  let zeros = new Uint16Array(0);
  for (const id of ids) {
    for (const [start, count] of lod.ranges.get(id) ?? []) {
      if (zeros.length < count) zeros = new Uint16Array(count);
      device.queue.writeBuffer(buffer, start * 2, zeros, 0, count);
    }
    lod.ranges.delete(id);
  }
}
