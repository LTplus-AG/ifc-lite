/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Scene's compact geometry: which queued meshes may draw from compact
 * pages (`compact-store.ts`), their upload, and the way back.
 *
 * A compact mesh draws from its records only where that is exactly what the
 * bucket path would have drawn:
 *
 * - its records carry the id and colour salt the scene draws it with (a host
 *   that re-homes ids or recolours a mesh after the worker encoded it gets the
 *   bucket path for that mesh);
 * - its model has no placement and its `origin` is the one it was adopted with (records cannot move);
 * - the scene keeps CPU geometry and has the quantized pipelines that draw 12-byte records;
 * - it is one entity with one colour and no texture.
 *
 * Any other compact mesh is decoded (`@ifc-lite/geometry` compact-shell.ts) and
 * handed back to the caller as an ordinary f32 mesh.
 *
 * Pages are outside the Scene's buckets, so nothing that edits, moves, removes,
 * recolours or evicts bucket geometry can reach them. `demote` is the single
 * way back: it decodes every paged mesh, destroys the pages and appends the
 * meshes through the bucket path. The Scene calls it before any such operation.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { compactRow, COMPACT_RECORD_BYTES, materializeCompactMesh, type CompactRef } from '@ifc-lite/geometry/compact';
import { CompactGeometryStore, type CompactStoreStats } from './compact-store.js';
import type { RenderPipeline } from './pipeline.js';
import type { CompactPageDeps } from './compact-page-deps.js';
import type { BatchedMesh } from './types.js';

/** The Scene members this module works through (the Scene passes itself, as it does to its snapshot lifecycle). */
export interface SceneCompactHost {
  ephemeralStreamingMode: boolean;
  geometryReleased: boolean;
  /** The quantized pipelines exist: without them a 12-byte page cannot be drawn. */
  quantizedBatchesEnabled: boolean;
  finalizeInProgress: boolean;
  nextBatchId: number;
  streamingFragments: readonly BatchedMesh[];
  streamedBucketKeys: ReadonlySet<string>;
  meshQueue: MeshData[];
  meshDataMap: Map<number, MeshData[]>;
  modelTranslations: { isPlaced(modelIndex: number): boolean; placeMesh(mesh: MeshData): MeshData };
  triangleCounts: { uploaded(meshes: readonly MeshData[]): void };
  colorKey(color: readonly [number, number, number, number], material?: MeshData['material']): string;
  addMeshData(mesh: MeshData): void;
  splitMeshForStreaming(mesh: MeshData): MeshData[];
  appendToBatches(meshes: MeshData[], device: GPUDevice, pipeline: RenderPipeline, isStreaming: boolean, sourceCounted: boolean): void;
  bumpPickGeometryRevision(): void;
}

/** The mesh still has the origin its records were adopted under (records hold world positions and cannot follow a new one). */
function unmoved(mesh: MeshData, ref: CompactRef): boolean {
  const now = mesh.origin, then = ref.origin;
  return (now?.[0] ?? 0) === (then?.[0] ?? 0) && (now?.[1] ?? 0) === (then?.[1] ?? 0) && (now?.[2] ?? 0) === (then?.[2] ?? 0);
}

function recordedLane(ref: CompactRef): number {
  const { records } = ref.payload;
  const at = records.byteOffset + compactRow(ref).vertexStart * COMPACT_RECORD_BYTES + 8;
  return new DataView(records.buffer, at, 4).getUint32(0, true);
}

export class SceneCompact {
  private readonly store: CompactGeometryStore;
  private queue: MeshData[] = [];
  /** Every paged mesh: the caller's object, and the one the Scene keeps for it. */
  private members: Array<{ source: MeshData; kept: MeshData }> = [];
  private gpu: { device: GPUDevice; pipeline: RenderPipeline } | null = null;
  private combined: { version: number; list: BatchedMesh[] } | null = null;
  private demotionRequested = false;
  /** Pages were rebuilt outside a stream (after a device loss): trim them at the drain that uploads them. */
  private trimAfterDrain = false;

  constructor(private readonly scene: SceneCompactHost, private readonly deps: CompactPageDeps) {
    this.store = new CompactGeometryStore(deps);
  }

  private eligible(mesh: MeshData): boolean {
    const ref = mesh.compact;
    return ref !== undefined
      && mesh.expressId >= 0 && mesh.expressId <= 0x00ffffff
      && !mesh.entityIds && !mesh.uvs && !mesh.texture && !mesh.textureRef
      && !this.scene.modelTranslations.isPlaced(mesh.modelIndex ?? 0)
      && unmoved(mesh, ref)
      && recordedLane(ref) === this.deps.laneOf(mesh);
  }

  /**
   * Queue the meshes that may draw from pages; returns the rest for the bucket
   * path, every compact one among them decoded to an ordinary f32 mesh (so
   * nothing downstream mistakes it for a paged mesh).
   */
  take(meshes: MeshData[]): MeshData[] {
    if (!meshes.some((mesh) => mesh.compact)) return meshes;
    const scene = this.scene;
    // A scene that keeps no CPU geometry (ephemeral streaming, released) has no bucket path to fall back to.
    const pages = scene.quantizedBatchesEnabled && !scene.ephemeralStreamingMode && !scene.geometryReleased;
    const rest: MeshData[] = [];
    for (const mesh of meshes) {
      if (pages && this.eligible(mesh)) { this.queue.push(mesh); continue; }
      materializeCompactMesh(mesh);
      rest.push(mesh);
    }
    return rest;
  }

  /** Work for the next `drain`: queued meshes, or a demotion asked for mid-frame. */
  get hasQueued(): boolean { return this.queue.length > 0 || this.demotionRequested; }

  /**
   * Ask for `demote` at the next `drain`. For a need found while a frame is being drawn (a page that
   * would have to be split into sub-batches), when the batch list must not change under the draw loop.
   */
  requestDemotion(): void {
    if (this.members.length > 0) this.demotionRequested = true;
  }

  /** Queued meshes, or pages whose buffers still carry growth slack: the stream has not settled. */
  get unsettled(): boolean { return this.queue.length > 0 || this.store.untrimmed; }
  get stats(): CompactStoreStats { return this.store.stats; }
  /** Meshes currently drawn from pages. */
  get meshCount(): number { return this.members.length; }

  /**
   * `flat` followed by the pages. The list is reused while it still says that:
   * the Scene replaces entries of `flat` in place (a batch rebuilt after
   * eviction or a device loss), so the entries are compared, not the array.
   */
  withPages(flat: BatchedMesh[]): BatchedMesh[] {
    const pages = this.store.batches;
    if (pages.length === 0) return flat;
    const c = this.combined;
    if (c && c.version === this.store.version && c.list.length === flat.length + pages.length
      && flat.every((batch, i) => c.list[i] === batch)) return c.list;
    const list = flat.concat(pages);
    this.combined = { version: this.store.version, list };
    return list;
  }

  /** Upload the queued meshes (or run a requested demotion). Returns whether anything changed. */
  drain(device: GPUDevice, pipeline: RenderPipeline): boolean {
    this.gpu = { device, pipeline };
    // A time-sliced finalize owns the batch list until it swaps: the demotion waits for it.
    if (this.demotionRequested && !this.scene.finalizeInProgress) return this.demote();
    if (this.queue.length === 0) return false;
    // A queued mesh may have changed since `take`: its geometry written, or its id, colour, origin or
    // model placement set. Judged again here, it goes to the bucket queue when a page no longer draws it.
    const queue: MeshData[] = [];
    for (const mesh of this.queue) {
      if (this.eligible(mesh)) { queue.push(mesh); continue; }
      materializeCompactMesh(mesh);
      this.scene.meshQueue.push(...this.scene.splitMeshForStreaming(mesh));
    }
    this.queue = [];
    if (queue.length === 0) return true;
    try {
      this.store.append(queue, device, pipeline, (mesh, ref) => {
        const c = ref.payload.cells, r = ref.row * 3;
        const key = `compact~${c[r]},${c[r + 1]},${c[r + 2]}~${this.scene.colorKey(mesh.color, mesh.material)}`;
        return mesh.modelIndex ? `model${mesh.modelIndex}~${key}` : key;
      }, () => this.scene.nextBatchId++);
    } catch (error) {
      // The upload died part-way (a device lost inside a GPU call): some pages hold some of these meshes.
      // Queue them all again and drop every page, so the next drain rebuilds from a known state.
      this.queue = queue;
      this.requeuePages(true);
      throw error;
    }
    for (const source of queue) {
      this.scene.addMeshData(source);
      this.members.push({ source, kept: this.scene.modelTranslations.placeMesh(source) });
    }
    this.scene.triangleCounts.uploaded(queue);
    if (this.trimAfterDrain) {
      this.trimAfterDrain = false;
      this.store.trim(device);
    }
    this.scene.bumpPickGeometryRevision();
    return true;
  }

  /**
   * The frame a highlight copy of a paged mesh is built in, so it lands on the page's own vertices:
   * the store origin, snapped to the 2^-10 lattice only where the page is (a finer or coarser row keeps
   * its decoded positions, which are exact in f32 against that origin). Undefined for any other mesh.
   */
  frameOf(mesh: MeshData): { sharedOrigin: readonly [number, number, number] | null; quantized: boolean } | undefined {
    if (!mesh.compact) return undefined;
    return { sharedOrigin: this.store.origin, quantized: compactRow(mesh.compact).level === 10 };
  }

  /** Stream end: upload what is queued and trim the pages to size. */
  settle(device: GPUDevice, pipeline: RenderPipeline): void {
    this.drain(device, pipeline);
    if (this.store.untrimmed) this.store.trim(device);
  }

  /** Take the page-time registrations of `members` out of the Scene's mesh map (they are registered again later). */
  private forget(members: ReadonlyArray<{ kept: MeshData }>): void {
    const kept = new Set(members.map((member) => member.kept));
    for (const [id, pieces] of this.scene.meshDataMap) {
      const rest = pieces.filter((piece) => !kept.has(piece));
      if (rest.length === 0) this.scene.meshDataMap.delete(id);
      else if (rest.length !== pieces.length) this.scene.meshDataMap.set(id, rest);
    }
  }

  /**
   * Move every compact mesh to the bucket path: the queued ones are decoded
   * and queued there, the uploaded ones are decoded, their pages destroyed and
   * their meshes appended to buckets. Returns whether anything moved.
   */
  demote(): boolean {
    this.demotionRequested = false;
    const scene = this.scene;
    const queued = this.queue;
    this.queue = [];
    for (const mesh of queued) {
      materializeCompactMesh(mesh);
      scene.meshQueue.push(...scene.splitMeshForStreaming(mesh));
    }
    if (this.members.length === 0) return queued.length > 0;
    const members = this.members;
    // The bucket path registers each mesh again: take the page-time registrations out first.
    this.forget(members);
    const sources = members.map((member) => {
      materializeCompactMesh(member.kept);
      materializeCompactMesh(member.source);
      return member.source;
    });
    // `drain` uploaded them, so its device is known. While a stream or its finalize is under way they
    // join it as fragments; a synchronous rebuild would republish the batch list without the stream's.
    const streaming = scene.streamingFragments.length > 0 || scene.streamedBucketKeys.size > 0 || scene.finalizeInProgress;
    let failure: unknown;
    let failed = false;
    try {
      scene.appendToBatches(sources, this.gpu!.device, this.gpu!.pipeline, streaming, true);
    } catch (error) {
      failure = error;
      failed = true;
    }
    // The append validates before it changes anything and builds GPU batches last. If it refused the
    // meshes outright they are in no bucket: the pages still draw them, so pages and registrations stay.
    if (failed && !members.every((member) => scene.meshDataMap.get(member.kept.expressId)?.includes(member.kept))) {
      for (const source of sources) scene.addMeshData(source);
      throw failure;
    }
    // Buckets hold them now (their batches built, or pending like any bucket whose build failed): the pages go.
    this.members = [];
    this.store.destroy();
    this.combined = null;
    scene.bumpPickGeometryRevision();
    if (failed) throw failure;
    return true;
  }

  /**
   * The GPU device is lost, and every page with it. The paged meshes are
   * queued again, still compact, and upload to the next device at its first
   * `drain`. Nothing here touches the lost device.
   */
  onDeviceLost(): void {
    if (this.members.length === 0 && this.store.size === 0) return;
    this.requeuePages(false);
  }

  /** Every paged mesh back in the queue, still compact, and no page left. */
  private requeuePages(release: boolean): void {
    this.forget(this.members);
    this.queue = this.members.map((member) => member.source).concat(this.queue);
    this.members = [];
    this.store.destroy(release);
    this.combined = null;
    this.gpu = null;
    this.demotionRequested = false; // it was asked of pages that no longer exist
    this.trimAfterDrain = true;
    this.scene.bumpPickGeometryRevision();
  }

  /** Drop everything without rebuilding (the Scene is clearing its flat geometry). */
  clear(): void {
    this.store.destroy();
    this.queue = [];
    this.members = [];
    this.combined = null;
    this.demotionRequested = false;
    this.trimAfterDrain = false;
  }
}
