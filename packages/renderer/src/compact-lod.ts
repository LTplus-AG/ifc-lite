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
import { COMPACT_RECORD_BYTES, compactRow, compactStep, type CompactRef } from '@ifc-lite/geometry/compact';
import type { CompactPageDeps } from './compact-page-deps.js';
import type { CompactGeometryStore, CompactPage } from './compact-store.js';
import type { LodPart } from './lod-parts.js';
import type { SceneCompactHost } from './scene-compact-host.js';

/** Scratch record per vertex: position xyz (page frame) and the u32 entity lane. */
const SCRATCH_FLOATS = 4;
/** Vertices a page holds at most: every page draws with u16 indices (compact-store.ts). */
export const MAX_PAGE_VERTICES = 65536;
const ZERO_POSITION = new Float32Array(3);

/** A page's LOD state: where each entity's LOD1 triangles are, so a retired entity's can be emptied. */
export interface PageLod {
  /** Entity id -> its [start, count] ranges in the page's LOD1 index buffer (one per part it is in). */
  ranges: Map<number, Array<[number, number]>>;
  bytes: number;
}

/** The bucket a set of paged meshes would share. */
interface Group {
  bounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
  /** Its batch would stay exact f32. */
  exact: boolean;
  members: MeshData[];
  /** LOD1 indices the clustering kept over every part, or -1 when it refused one. */
  kept: number;
}

/** The bucket key of each paged mesh. Cached: a mesh whose colour, id or model changes leaves its page first. */
const bucketKeys = new WeakMap<MeshData, string>();

function bucketKeyOf(host: SceneCompactHost, mesh: MeshData): string {
  let key = bucketKeys.get(mesh);
  if (key === undefined) {
    // The chunk cell is taken at the first source vertex, which the encoder writes first (welding keeps first occurrences).
    key = host.compactBucketKey(mesh, { origin: firstVertex(mesh.compact!), positions: ZERO_POSITION });
    bucketKeys.set(mesh, key);
  }
  return key;
}

/** Every page's meshes, grouped by the bucket the bucket path would file them in, in page order. */
function collectGroups(store: CompactGeometryStore, host: SceneCompactHost, deps: CompactPageDeps): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const page of store.pageList()) {
    for (const mesh of page.meshes) {
      if (!mesh.compact) continue; // written since it was paged: `buildPageLods` leaves its page as it is
      const key = bucketKeyOf(host, mesh);
      let group = groups.get(key);
      if (!group) {
        group = { bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, triangles: 0, exact: false, members: [], kept: 0 };
        groups.set(key, group);
      }
      const ref = mesh.compact!, row = compactRow(ref), b = ref.payload.bounds, o = ref.row * 6;
      for (let axis = 0; axis < 3; axis++) {
        group.bounds.min[axis] = Math.min(group.bounds.min[axis], b[o + axis]);
        group.bounds.max[axis] = Math.max(group.bounds.max[axis], b[o + 3 + axis]);
      }
      group.triangles += row.indexCount / 3;
      // A lattice finer than the bucket batch's: the bucket's collapsed it (one coarser only outgrew its window).
      if (compactStep(row.level) < deps.bucket.quantStep) group.exact = true;
      group.members.push(mesh);
    }
  }
  const { quantStep, maxQuantExtent } = deps.bucket;
  for (const group of groups.values()) {
    // quantize.ts: the batch's lower corner floors to the lattice; past `maxQuantExtent` above it the batch stays f32.
    const { min, max } = group.bounds;
    for (let axis = 0; axis < 3; axis++) if (max[axis] - Math.floor(min[axis] / quantStep) * quantStep > maxQuantExtent) group.exact = true;
  }
  return groups;
}

/** World position of a row's first record. */
function firstVertex(ref: CompactRef): [number, number, number] {
  const { vertexStart, level } = compactRow(ref);
  const step = compactStep(level), w = ref.payload.windows, r = ref.row * 3, records = ref.payload.records;
  const view = new DataView(records.buffer, records.byteOffset + vertexStart * COMPACT_RECORD_BYTES, 6);
  return [(w[r] + view.getUint16(0, true)) * step, (w[r + 1] + view.getUint16(2, true)) * step, (w[r + 2] + view.getUint16(4, true)) * step];
}

/**
 * The pages were trimmed at the end of a stream: hand the meshes of every group whose bucket batch would
 * stay exact f32 to `toBuckets` now (they join the stream's finalize), and return the build of the pages'
 * parts when bucket batches build LOD1 (null otherwise). The caller runs it a slice at a time and drops it
 * when the pages change under it.
 */
export function settlePages(
  store: CompactGeometryStore, host: SceneCompactHost, device: GPUDevice, deps: CompactPageDeps, toBuckets: (exact: MeshData[]) => void,
): PageLodBuild | null {
  const t0 = performance.now();
  const groups = collectGroups(store, host, deps);
  const exact: MeshData[] = [];
  for (const group of groups.values()) if (group.exact) exact.push(...group.members);
  if (exact.length > 0) toBuckets(exact);
  store.stats.settleMs += performance.now() - t0;
  return host.lodBuildsEnabled ? new PageLodBuild(store, buildPageLods(store, groups, device, deps)) : null;
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
  parts: Array<{ group: Group; meshes: MeshData[]; lod1: Uint16Array | null; runs: EntityRun[] }>;
}

/**
 * Rewrite every page's index buffer by group and give it each group's LOD1 range. `groups` is what
 * `collectGroups` returned for the pages; the meshes of an exact group that left them since are skipped (no
 * group decision changes: an exact group gets no LOD1).
 */
function* buildPageLods(store: CompactGeometryStore, groups: Map<string, Group>, device: GPUDevice, deps: CompactPageDeps): Generator<void, void, void> {
  const { simplify, lodCellSize, lodMinTriangles, lodMaxKeptFraction } = deps.bucket;
  const groupOf = new Map<MeshData, Group>();
  for (const group of groups.values()) for (const mesh of group.members) groupOf.set(mesh, group);
  let scratch: Float32Array | null = null, lanes: Uint32Array | null = null; // allocated by the first page that clusters
  const plans: PagePlan[] = [];
  for (const page of store.pageList()) {
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
      let lod1: Uint16Array | null = null;
      const runs: EntityRun[] = [];
      if (!group.exact && group.kept >= 0 && group.triangles >= lodMinTriangles) {
        scratch ??= new Float32Array(MAX_PAGE_VERTICES * SCRATCH_FLOATS);
        lanes ??= new Uint32Array(scratch.buffer);
        if (!decoded) { readRecords(store, page, scratch, lanes); decoded = true; }
        const out = simplify(scratch.subarray(0, page.vertexCount * SCRATCH_FLOATS), SCRATCH_FLOATS, sourceIndices(store, meshes),
          lodCellSize(group.bounds.min, group.bounds.max), { idLaneOffset: 3, frameOrigin: store.origin!, unconditional: true });
        if (out) {
          group.kept += out.length;
          lod1 = Uint16Array.from(out);
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
      plan.parts.push({ group, meshes, lod1, runs });
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

/** Positions (page frame) and lanes of `page`'s records, at their page vertex numbers. */
function readRecords(store: CompactGeometryStore, page: CompactPage, scratch: Float32Array, lanes: Uint32Array): void {
  const q = page.batch.quantized!;
  for (const mesh of page.meshes) {
    const slot = store.slotOf(mesh)!, ref = mesh.compact!, records = ref.payload.records;
    const view = new DataView(records.buffer, records.byteOffset + compactRow(ref).vertexStart * COMPACT_RECORD_BYTES, slot.vertexCount * COMPACT_RECORD_BYTES);
    for (let v = 0, at = 0, out = slot.base * SCRATCH_FLOATS; v < slot.vertexCount; v++, at += COMPACT_RECORD_BYTES, out += SCRATCH_FLOATS) {
      scratch[out] = q.min[0] + view.getUint16(at, true) * q.step;
      scratch[out + 1] = q.min[1] + view.getUint16(at + 2, true) * q.step;
      scratch[out + 2] = q.min[2] + view.getUint16(at + 4, true) * q.step;
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
      for (const { from, to, id } of part.runs) {
        const n = padded(to - from);
        lod1.set(part.lod1.subarray(from, to), w1);
        lod1.fill(part.lod1[from], w1 + to - from, w1 + n);
        const ranges = lod.ranges.get(id);
        if (ranges) ranges.push([w1, n]); else lod.ranges.set(id, [[w1, n]]);
        w1 += n;
      }
    }
    parts.push({ bounds: part.group.bounds, lod0Start, lod0Count: w0 - lod0Start, lod1Start, lod1Count: w1 - lod1Start });
  }
  replaceIndices(store, plan.page, lod0, starts, device);
  setPageLod(store, plan.page, parts, lod1, lod, device);
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
function setPageLod(store: CompactGeometryStore, page: CompactPage, parts: LodPart[], lod1: Uint16Array | null, lod: PageLod, device: GPUDevice): void {
  dropPageLod(store, page);
  if (lod1) {
    const buffer = device.createBuffer({ size: Math.max(4, lod1.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, lod1);
    page.batch.lod1IndexBuffer = buffer;
    page.batch.lod1IndexCount = lod1.length;
    lod.bytes = buffer.size;
    store.stats.lod1Bytes += buffer.size;
  }
  page.batch.lodParts = parts;
  page.lod = lod;
}

/** Take `page`'s parts and LOD1 buffer away: it draws as one batch, every index. */
export function dropPageLod(store: CompactGeometryStore, page: CompactPage): void {
  if (!page.lod) return;
  page.batch.lod1IndexBuffer?.destroy();
  store.stats.lod1Bytes -= page.lod.bytes;
  delete page.batch.lod1IndexBuffer;
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
