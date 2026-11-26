/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact geometry store.
 *
 * Meshes the wasm encoder wrote as final 12-byte quantized records
 * (`@ifc-lite/geometry` compact-geometry.ts) are uploaded here as they arrive,
 * with no interleave, no quantize pass, no bounds walk and no finalize rebuild:
 *
 * - one bucket per (model, lattice level, cell, colour + finish). Every mesh of
 *   a level and cell shares its lattice window, so a bucket's vertex buffer is
 *   the plain concatenation of its meshes' records (`writeBuffer` straight from
 *   the transferred bytes, coalesced over contiguous runs);
 * - a bucket is a list of PAGES of at most 65,536 vertices, so every page
 *   draws with u16 indices (`BatchedMesh.indexFormat = 'uint16'`). The
 *   mesh-local u16 indices are rebased by the page's vertex base, the only
 *   per-element loop on the main thread (it reads indices, never vertices);
 * - pages grow by doubling with a GPU `copyBufferToBuffer` and are trimmed to
 *   their exact size when the stream ends;
 * - every page dequantizes against ONE store-wide origin snapped to 2^-9 m,
 *   `quantized.min = window - origin`, an exact f32 multiple of its own step,
 *   so coincident points across pages stay bit-coincident as on the bucket
 *   path's quantized batches.
 *
 * Pages are ordinary `BatchedMesh`es: the draw loop, lane picking, the entity
 * visibility and colour tables, highlight, shadows and section discard work on
 * them unchanged. They are not in the Scene's buckets; `scene-compact.ts` moves
 * a scene's compact meshes back to buckets before anything that needs those.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { COMPACT_RECORD_BYTES as RECORD_BYTES, compactRow, compactStep, type CompactRef } from '@ifc-lite/geometry/compact';
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import type { CompactPageDeps } from './compact-page-deps.js';
import { dropPageLod, retirePageLod, type PageLod } from './compact-lod.js';

/**
 * The store origin snaps to the coarsest level's step, so every level's quantMin is a multiple of its own
 * step. Bucket batch frames snap to the same lattice (`BATCH_ORIGIN_STEP`, scene-precision.ts), so a vertex
 * lands on one node on either path; not imported from there, which would pull an eager module into this chunk.
 */
const ORIGIN_STEP = 2 ** -9;
const MAX_PAGE_VERTICES = 65536;

export interface CompactPage {
  key: string;
  batch: BatchedMesh;
  window: [number, number, number];
  vertexCount: number;
  vertexCapacity: number;
  indexCount: number;
  indexCapacity: number;
  /** Meshes still drawn from this page; when the last one leaves, the page is destroyed. */
  meshes: Set<MeshData>;
  /** Its LOD parts and LOD1 buffer (compact-lod.ts); dropped when a mesh is appended. */
  lod?: PageLod;
}

/** Where one mesh's triangles sit in its page: retiring it rewrites that index range. */
export interface CompactSlot {
  page: CompactPage;
  /** First index (u16 element) of the mesh in the page's index buffer, and how many it wrote (with padding). */
  indexStart: number;
  indexCount: number;
  /** The page vertex its rebased indices start at; a retired range repeats it. */
  base: number;
  vertexCount: number;
  triangles: number;
}

export interface CompactStoreStats {
  meshes: number;
  pages: number;
  vertices: number;
  triangles: number;
  /** Bytes the pages use (records + u16 indices, incl. padding triangles). */
  usedBytes: number;
  /** Bytes the pages' GPU buffers hold (capacity). */
  allocatedBytes: number;
  vertexWrites: number;
  indexWrites: number;
  grows: number;
  /** Main-thread ms spent in `append` and `trim`. */
  appendMs: number;
  trimMs: number;
  /** Bytes of the pages' LOD1 index buffers (compact-lod.ts; not in `allocatedBytes`), and ms spent in its `settlePages`. */
  lod1Bytes: number;
  settleMs: number;
}

export class CompactGeometryStore {
  constructor(private readonly deps: CompactPageDeps) {}

  private readonly pages = new Map<string, CompactPage[]>();
  private readonly slots = new Map<MeshData, CompactSlot>();
  private readonly byBatch = new Map<BatchedMesh, CompactPage>();
  /** Page names stay unique after a page is destroyed (a list's length would hand one out twice). */
  private nextOrdinal = 0;
  readonly batches: BatchedMesh[] = [];
  /** Bumps whenever `batches` or a page's draw range changes. */
  version = 0;
  /** The origin every page dequantizes against; null until the first page. */
  origin: [number, number, number] | null = null;
  private scratch = new Uint16Array(0);
  readonly stats: CompactStoreStats = {
    meshes: 0, pages: 0, vertices: 0, triangles: 0, usedBytes: 0, allocatedBytes: 0,
    vertexWrites: 0, indexWrites: 0, grows: 0, appendMs: 0, trimMs: 0, lod1Bytes: 0, settleMs: 0,
  };

  get size(): number { return this.batches.length; }
  /** Pages appended to since the last trim (their buffers have growth slack). */
  untrimmed = false;

  /**
   * Upload compact meshes. `keyOf` names a mesh's bucket (cell + colour);
   * `nextId` hands out batch ids from the Scene's counter.
   */
  append(
    meshes: readonly MeshData[],
    device: GPUDevice,
    pipeline: RenderPipeline,
    keyOf: (mesh: MeshData, ref: CompactRef) => string,
    nextId: () => number,
  ): void {
    const t0 = performance.now();
    // A run: consecutive meshes of one page whose records are contiguous in one payload.
    let run: { page: CompactPage; records: Uint8Array; start: number; end: number; dst: number } | null = null;
    const flushRun = (): void => {
      if (!run) return;
      device.queue.writeBuffer(run.page.batch.vertexBuffer, run.dst, run.records, run.start, run.end - run.start);
      this.stats.vertexWrites++;
      run = null;
    };
    for (const mesh of meshes) {
      const ref = mesh.compact;
      if (!ref) continue;
      const { vertexStart, vertexCount, indexStart, indexCount, level } = compactRow(ref);
      const step = compactStep(level);
      const window = this.windowOf(ref);
      // A page holds one lattice level and one window: the key carries the level, the cell names the window.
      const key = `${keyOf(mesh, ref)}~L${level}`;
      const page = this.pageFor(key, mesh, window, step, vertexCount, device, pipeline, nextId, flushRun);
      dropPageLod(this, page); // its parts no longer cover its indices: built again when the stream settles
      // Vertices: extend the run or start a new one.
      const srcStart = vertexStart * RECORD_BYTES, srcEnd = srcStart + vertexCount * RECORD_BYTES;
      const dst = page.vertexCount * RECORD_BYTES;
      if (!(run && run.page === page && run.records === ref.payload.records && run.end === srcStart)) {
        flushRun();
        run = { page, records: ref.payload.records, start: srcStart, end: srcStart, dst };
      }
      run.end = srcEnd;
      // Indices: rebase by the page's vertex base; pad to an even triangle count (4-byte writes).
      const base = page.vertexCount;
      const padded = indexCount + ((indexCount / 3) & 1 ? 3 : 0);
      this.ensureIndexCapacity(page, page.indexCount + padded, device, flushRun);
      if (this.scratch.length < padded) this.scratch = new Uint16Array(Math.max(padded, this.scratch.length * 2));
      const src = ref.payload.indices;
      const out = this.scratch;
      for (let i = 0; i < indexCount; i++) out[i] = src[indexStart + i] + base;
      for (let i = indexCount; i < padded; i++) out[i] = base;
      device.queue.writeBuffer(page.batch.indexBuffer, page.indexCount * 2, out, 0, padded);
      this.stats.indexWrites++;
      this.slots.set(mesh, { page, indexStart: page.indexCount, indexCount: padded, base, vertexCount, triangles: indexCount / 3 });
      page.meshes.add(mesh);
      page.indexCount += padded;
      page.vertexCount += vertexCount;
      page.batch.indexCount = page.indexCount;
      unionBounds(page.batch, ref);
      page.batch.expressIds.push(mesh.expressId);
      page.batch.modelIndices?.push(mesh.modelIndex);
      page.batch.entryRevision!++;
      this.stats.meshes++;
      this.stats.vertices += vertexCount;
      this.stats.triangles += indexCount / 3;
      this.stats.usedBytes += vertexCount * RECORD_BYTES + padded * 2;
    }
    flushRun();
    this.untrimmed = true;
    this.version++;
    this.stats.appendMs += performance.now() - t0;
  }

  /** Every page, in creation order per bucket, and a mesh's slot (compact-lod.ts rewrites both). */
  *pageList(): IterableIterator<CompactPage> { for (const list of this.pages.values()) yield* list; }
  slotOf(mesh: MeshData): CompactSlot | undefined { return this.slots.get(mesh); }

  /** The meshes `page` (one of `batches`) draws; undefined for any other batch. */
  meshesOn(page: BatchedMesh): ReadonlySet<MeshData> | undefined {
    return this.byBatch.get(page)?.meshes;
  }

  /**
   * Stop drawing `meshes` from their pages, leaving every other mesh where it
   * is: each one's index range is rewritten to repeat a single vertex (empty
   * triangles, which rasterize nothing), its id leaves the page's id list, and
   * a page with no mesh left is destroyed. The vertex records stay until then.
   */
  retire(meshes: Iterable<MeshData>, device: GPUDevice): void {
    const slots: CompactSlot[] = [];
    const byPage = new Map<CompactPage, MeshData[]>();
    for (const mesh of meshes) {
      const slot = this.slots.get(mesh);
      if (!slot) continue;
      this.slots.delete(mesh);
      slots.push(slot);
      const list = byPage.get(slot.page);
      if (list) list.push(mesh); else byPage.set(slot.page, [mesh]);
      const { batch } = slot.page;
      const at = batch.expressIds.indexOf(mesh.expressId);
      if (at >= 0) { batch.expressIds.splice(at, 1); batch.modelIndices?.splice(at, 1); batch.entryRevision!++; }
      slot.page.meshes.delete(mesh);
      this.stats.meshes--;
      this.stats.vertices -= slot.vertexCount;
      this.stats.triangles -= slot.triangles;
    }
    if (slots.length === 0) return;
    // A page every mesh left is destroyed whole; only the ranges of pages that keep drawing are rewritten.
    for (const slot of slots) {
      if (slot.page.meshes.size === 0) continue;
      if (this.scratch.length < slot.indexCount) this.scratch = new Uint16Array(Math.max(slot.indexCount, this.scratch.length * 2));
      this.scratch.fill(slot.base, 0, slot.indexCount);
      device.queue.writeBuffer(slot.page.batch.indexBuffer, slot.indexStart * 2, this.scratch, 0, slot.indexCount);
      this.stats.indexWrites++;
    }
    for (const [page, left] of byPage) if (page.meshes.size === 0) this.destroyPage(page); else retirePageLod(this, page, left, device);
    this.version++;
  }

  private destroyPage(page: CompactPage): void {
    dropPageLod(this, page);
    const list = this.pages.get(page.key);
    const at = list?.indexOf(page) ?? -1;
    if (at >= 0) list!.splice(at, 1);
    if (list?.length === 0) this.pages.delete(page.key);
    const batch = this.batches.indexOf(page.batch);
    if (batch >= 0) this.batches.splice(batch, 1);
    this.byBatch.delete(page.batch);
    this.deps.destroyGpuResources(page.batch);
    this.stats.pages--;
    this.stats.allocatedBytes -= page.vertexCapacity * RECORD_BYTES + page.indexCapacity * 2;
    this.stats.usedBytes -= page.vertexCount * RECORD_BYTES + page.indexCount * 2;
    if (this.batches.length === 0) { this.origin = null; this.untrimmed = false; } // as `destroy` leaves an empty store
  }

  /** Shrink every page's buffers to what it uses (GPU copies only). */
  trim(device: GPUDevice): void {
    const t0 = performance.now();
    const encoder = device.createCommandEncoder();
    const retired: GPUBuffer[] = [];
    let copies = 0;
    for (const list of this.pages.values()) {
      for (const page of list) {
        if (page.vertexCapacity > page.vertexCount) {
          const bytes = Math.max(4, page.vertexCount * RECORD_BYTES);
          const next = device.createBuffer({ size: bytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
          encoder.copyBufferToBuffer(page.batch.vertexBuffer, 0, next, 0, page.vertexCount * RECORD_BYTES);
          retired.push(page.batch.vertexBuffer);
          this.stats.allocatedBytes += bytes - page.vertexCapacity * RECORD_BYTES;
          page.batch.vertexBuffer = next; page.vertexCapacity = page.vertexCount; copies++;
        }
        if (page.indexCapacity > page.indexCount) {
          const bytes = Math.max(4, page.indexCount * 2);
          const next = device.createBuffer({ size: bytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
          encoder.copyBufferToBuffer(page.batch.indexBuffer, 0, next, 0, page.indexCount * 2);
          retired.push(page.batch.indexBuffer);
          this.stats.allocatedBytes += bytes - page.indexCapacity * 2;
          page.batch.indexBuffer = next; page.indexCapacity = page.indexCount; copies++;
        }
      }
    }
    if (copies > 0) device.queue.submit([encoder.finish()]);
    this.untrimmed = false;
    for (const b of retired) b.destroy();
    this.stats.trimMs += performance.now() - t0;
  }

  /** Drop every page. `release = false` leaves their GPU buffers alone (their device is lost). */
  destroy(release = true): void {
    if (release) for (const batch of this.batches) this.deps.destroyGpuResources(batch);
    this.batches.length = 0;
    this.pages.clear();
    this.slots.clear();
    this.byBatch.clear();
    this.origin = null;
    this.untrimmed = false;
    this.version++;
    // What is held now; the write and timing counters stay cumulative.
    Object.assign(this.stats, { meshes: 0, pages: 0, vertices: 0, triangles: 0, usedBytes: 0, allocatedBytes: 0, lod1Bytes: 0 });
  }

  private windowOf(ref: CompactRef): [number, number, number] {
    const w = ref.payload.windows, r = ref.row * 3;
    return [w[r], w[r + 1], w[r + 2]];
  }

  private pageFor(
    key: string, mesh: MeshData, window: [number, number, number], step: number, vertexCount: number,
    device: GPUDevice, pipeline: RenderPipeline, nextId: () => number, flushRun: () => void,
  ): CompactPage {
    let list = this.pages.get(key);
    if (!list) { list = []; this.pages.set(key, list); }
    let page = list[list.length - 1];
    if (!page || page.vertexCount + vertexCount > MAX_PAGE_VERTICES) {
      flushRun();
      page = this.createPage(key, this.nextOrdinal++, mesh, window, step, vertexCount, device, pipeline, nextId());
      list.push(page);
    } else {
      this.ensureVertexCapacity(page, page.vertexCount + vertexCount, device, flushRun);
    }
    return page;
  }

  private createPage(
    key: string, ordinal: number, mesh: MeshData, window: [number, number, number], step: number, vertexCount: number,
    device: GPUDevice, pipeline: RenderPipeline, id: number,
  ): CompactPage {
    // Store-wide origin near the first window, on the coarsest level's lattice: every
    // quantMin is then an exact f32 multiple of its own step (2^24 steps: 32 km at level 9, 1 km at 14).
    const snap = (v: number): number => Math.floor(v / ORIGIN_STEP) * ORIGIN_STEP;
    const origin = this.origin ??= [snap(window[0] * step), snap(window[1] * step), snap(window[2] * step)];
    const vertexCapacity = Math.min(MAX_PAGE_VERTICES, nextPow2(Math.max(vertexCount, 256)));
    const indexCapacity = nextPow2(768);
    const vertexBuffer = device.createBuffer({ size: vertexCapacity * RECORD_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const indexBuffer = device.createBuffer({ size: indexCapacity * 2, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const { uniformSlot, bindGroup } = this.deps.createBatchUniform(device, pipeline);
    this.stats.allocatedBytes += vertexCapacity * RECORD_BYTES + indexCapacity * 2;
    this.stats.pages++;
    const batch: BatchedMesh = {
      id,
      colorKey: `${key}#c${ordinal}`,
      vertexBuffer,
      indexBuffer,
      indexCount: 0,
      indexFormat: 'uint16',
      color: mesh.color,
      ...(mesh.material ? { finish: mesh.material } : {}),
      expressIds: [],
      entryRevision: 0,
      modelIndices: [],
      bindGroup,
      uniformSlot,
      bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
      origin: [origin[0], origin[1], origin[2]],
      quantized: { min: [window[0] * step - origin[0], window[1] * step - origin[1], window[2] * step - origin[2]], step },
    };
    this.deps.pinBatchEntityIdAnchor(batch, 0); // the page grows: its ids (all below 2^24) are not known yet
    this.batches.push(batch);
    const page: CompactPage = { key, batch, window, vertexCount: 0, vertexCapacity, indexCount: 0, indexCapacity, meshes: new Set() };
    this.byBatch.set(batch, page);
    return page;
  }

  private ensureVertexCapacity(page: CompactPage, needed: number, device: GPUDevice, flushRun: () => void): void {
    if (needed <= page.vertexCapacity) return;
    flushRun();
    const capacity = Math.min(MAX_PAGE_VERTICES, nextPow2(needed));
    page.batch.vertexBuffer = this.grow(page.batch.vertexBuffer, page.vertexCount * RECORD_BYTES, capacity * RECORD_BYTES,
      GPUBufferUsage.VERTEX, device);
    this.stats.allocatedBytes += (capacity - page.vertexCapacity) * RECORD_BYTES;
    page.vertexCapacity = capacity;
  }

  private ensureIndexCapacity(page: CompactPage, needed: number, device: GPUDevice, flushRun: () => void): void {
    if (needed <= page.indexCapacity) return;
    flushRun();
    const capacity = nextPow2(needed);
    page.batch.indexBuffer = this.grow(page.batch.indexBuffer, page.indexCount * 2, capacity * 2, GPUBufferUsage.INDEX, device);
    this.stats.allocatedBytes += (capacity - page.indexCapacity) * 2;
    page.indexCapacity = capacity;
  }

  private grow(old: GPUBuffer, usedBytes: number, size: number, usage: number, device: GPUDevice): GPUBuffer {
    const next = device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    if (usedBytes > 0) {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(old, 0, next, 0, usedBytes);
      device.queue.submit([encoder.finish()]);
    }
    old.destroy();
    this.stats.grows++;
    return next;
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function unionBounds(batch: BatchedMesh, ref: CompactRef): void {
  const b = ref.payload.bounds, o = ref.row * 6, box = batch.bounds!;
  for (let axis = 0; axis < 3; axis++) {
    if (b[o + axis] < box.min[axis]) box.min[axis] = b[o + axis];
    if (b[o + 3 + axis] > box.max[axis]) box.max[axis] = b[o + 3 + axis];
  }
}
