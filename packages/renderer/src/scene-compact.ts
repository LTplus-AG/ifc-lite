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
 * recolours or evicts bucket geometry can reach them. `demote` is the way
 * back, per mesh: it decodes the paged meshes an operation is about (an
 * entity's, a model's, or all of them), retires them from their pages and
 * appends them through the bucket path; every other mesh stays on its page.
 * The Scene calls it before any such operation. `drop` retires an entity's
 * meshes without moving them, for a removal.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { compactRow, materializeCompactMesh } from '@ifc-lite/geometry/compact';
import { CompactGeometryStore, type CompactStoreStats } from './compact-store.js';
import type { RenderPipeline } from './pipeline.js';
import type { CompactPageDeps } from './compact-page-deps.js';
import type { BatchedMesh } from './types.js';

import { normalize, recordedLane, unmoved, type CompactSelection, type SceneCompactHost, type Selection } from './scene-compact-host.js';

export type { CompactSelection, SceneCompactHost } from './scene-compact-host.js';

export class SceneCompact {
  private readonly store: CompactGeometryStore;
  private queue: MeshData[] = [];
  /** Every paged mesh: the caller's object -> the one the Scene keeps for it. */
  private members = new Map<MeshData, MeshData>();
  /** The paged meshes of each entity, so an edit of one entity does not walk every member. */
  private byId = new Map<number, MeshData[]>();
  private gpu: { device: GPUDevice; pipeline: RenderPipeline } | null = null;
  private combined: { version: number; list: BatchedMesh[] } | null = null;
  /** Pages a frame could not split into sub-batches: their meshes move to buckets at the next drain. */
  private demotionPages = new Set<BatchedMesh>();
  /** Paged meshes the bucket path refused: a frame's split request no longer asks for them. */
  private refused = new WeakSet<MeshData>();
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
  get hasQueued(): boolean { return this.queue.length > 0 || this.demotionPages.size > 0; }

  /**
   * Move `page`'s meshes to buckets at the next `drain`. For a need found while a frame is being drawn
   * (a page that would have to be split into sub-batches), when the batch list must not change under the
   * draw loop. Only that page's meshes move.
   */
  requestDemotion(page: BatchedMesh): void {
    // A page whose remaining meshes the bucket path refused is drawn whole from now on: nothing to ask for.
    const meshes = this.store.meshesOn(page);
    if (!meshes || this.demotionPages.has(page)) return;
    for (const mesh of meshes) if (!this.refused.has(mesh)) { this.demotionPages.add(page); return; }
  }

  /** Queued meshes, or pages whose buffers still carry growth slack: the stream has not settled. */
  get unsettled(): boolean { return this.queue.length > 0 || this.store.untrimmed; }
  get stats(): CompactStoreStats { return this.store.stats; }
  /** Meshes currently drawn from pages. */
  get meshCount(): number { return this.members.size; }

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
    let demoted = false;
    if (this.demotionPages.size > 0 && !this.scene.finalizeInProgress) {
      const pages = this.demotionPages;
      this.demotionPages = new Set();
      // A mesh the bucket path refused stays drawn whole from its page: asking again every frame would only fail again.
      const chosen: Array<[MeshData, MeshData]> = [];
      for (const page of pages) {
        for (const source of this.store.meshesOn(page) ?? []) if (!this.refused.has(source)) chosen.push([source, this.members.get(source)!]);
      }
      demoted = this.demoteChosen(chosen, false);
    }
    if (this.queue.length === 0) return demoted;
    // A queued mesh may have changed since `take`: its geometry written, or its id, colour, origin or
    // model placement set. Judged again here, it goes to the bucket queue when a page no longer draws it.
    const queue: MeshData[] = [];
    const scene = this.scene;
    const pages = scene.quantizedBatchesEnabled && !scene.ephemeralStreamingMode && !scene.geometryReleased;
    const decoded: MeshData[] = [];
    for (const mesh of this.queue) {
      if (pages && this.eligible(mesh)) { queue.push(mesh); continue; }
      decoded.push(mesh);
    }
    this.queue = [];
    this.toBuckets(decoded);
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
      this.members.set(source, this.scene.modelTranslations.placeMesh(source));
      const pieces = this.byId.get(source.expressId);
      if (pieces) pieces.push(source); else this.byId.set(source.expressId, [source]);
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

  /** Take the page-time registrations of these members out of the Scene's mesh map (they are registered again later). */
  private forget(kept: ReadonlySet<MeshData>): void {
    const ids = new Set([...kept].map((mesh) => mesh.expressId));
    for (const id of ids) {
      const pieces = this.scene.meshDataMap.get(id);
      if (!pieces) continue;
      const rest = pieces.filter((piece) => !kept.has(piece));
      if (rest.length === 0) this.scene.meshDataMap.delete(id);
      else if (rest.length !== pieces.length) this.scene.meshDataMap.set(id, rest);
    }
  }

  /** The members `selection` names, as [source, kept] pairs. */
  private chosen(selection: Selection): Array<[MeshData, MeshData]> {
    if (selection === undefined) return [...this.members];
    if ('modelIndex' in selection) return [...this.members].filter(([source]) => (source.modelIndex ?? 0) === selection.modelIndex);
    const chosen: Array<[MeshData, MeshData]> = [];
    for (const id of selection.ids) for (const source of this.byId.get(id) ?? []) chosen.push([source, this.members.get(source)!]);
    return chosen;
  }

  /** Take members off the books and retire their page ranges. */
  private unpage(sources: readonly MeshData[]): void {
    for (const source of sources) {
      this.members.delete(source);
      const pieces = this.byId.get(source.expressId);
      const at = pieces?.indexOf(source) ?? -1;
      if (at >= 0) pieces!.splice(at, 1);
      if (pieces?.length === 0) this.byId.delete(source.expressId);
    }
    this.store.retire(sources, this.gpu!.device);
    this.scene.bumpPickGeometryRevision();
  }

  /** Queued meshes `selection` names go to the bucket queue, decoded. Returns whether any did. */
  private demoteQueued(selection: Selection): boolean {
    // With no device yet (a recovery's queue before its first drain) they wait for `drain` to judge them.
    if (this.queue.length === 0 || (!this.gpu && !this.streaming)) return false;
    const keep: MeshData[] = [], decoded: MeshData[] = [];
    for (const mesh of this.queue) {
      const selected = selection === undefined || ('modelIndex' in selection
        ? (mesh.modelIndex ?? 0) === selection.modelIndex : selection.ids.has(mesh.expressId));
      (selected ? decoded : keep).push(mesh);
    }
    this.queue = keep;
    this.toBuckets(decoded);
    return decoded.length > 0;
  }

  /** A stream (or its finalize) is under way: bucket meshes join it as fragments, and its finalize merges them. */
  private get streaming(): boolean {
    const scene = this.scene;
    return scene.streamingFragments.length > 0 || scene.streamedBucketKeys.size > 0 || scene.finalizeInProgress;
  }

  /**
   * Decoded queued meshes onto the bucket path. During a stream they join its queue; outside one they are
   * appended at once, since a streaming fragment would wait for a finalize that never comes (a device
   * recovery whose pipelines did not come back, an edit right after one). One the bucket path refuses
   * keeps the queue, as any f32 mesh would.
   */
  private toBuckets(meshes: MeshData[]): void {
    if (meshes.length === 0) return;
    const scene = this.scene;
    for (const mesh of meshes) materializeCompactMesh(mesh);
    const now = this.gpu && !this.streaming ? meshes.filter((mesh) => !scene.refusesBucketPath(scene.modelTranslations.placeMesh(mesh))) : [];
    if (now.length > 0) scene.appendToBatches(now, this.gpu!.device, this.gpu!.pipeline, false, false);
    for (const mesh of meshes) if (!now.includes(mesh)) scene.meshQueue.push(...scene.splitMeshForStreaming(mesh));
  }

  /**
   * Move the compact meshes `selection` names (every one by default) to the
   * bucket path; the others stay on their pages. Queued ones are decoded and
   * queued there; uploaded ones are decoded, retired from their pages and
   * appended to buckets. Returns whether anything moved.
   *
   * Each mesh is judged first: one the bucket path would refuse stays on its
   * page, the rest move, and the call then throws, so an edit of that mesh
   * fails while edits of every other mesh go on working.
   */
  demote(selection?: CompactSelection): boolean {
    const normal = normalize(selection);
    const queued = this.demoteQueued(normal);
    return this.demoteChosen(this.chosen(normal)) || queued;
  }

  /**
   * The quantized pipelines went away: every uploaded page moves to buckets,
   * but queued meshes stay queued, still compact. A device recovery turns the
   * pipelines off while it rebuilds them, after the lost pages were queued
   * again; sent to the bucket queue then, they became streaming fragments no
   * stream would ever finalize. `drain` judges them against the pipelines it
   * finds (and decodes them only if the pipelines stay off).
   */
  demotePages(): boolean {
    return this.demoteChosen(this.chosen(undefined));
  }

  /** Move `chosen` to buckets, keeping refused meshes paged; throws for those when `strict` (an edit of them cannot proceed). */
  private demoteChosen(chosen: ReadonlyArray<[MeshData, MeshData]>, strict = true): boolean {
    if (chosen.length === 0) return false;
    const refused = new Set(chosen.filter(([, kept]) => this.scene.refusesBucketPath(kept)));
    const moving = refused.size === 0 ? chosen : chosen.filter((pair) => !refused.has(pair));
    if (moving.length > 0) this.move(moving);
    if (refused.size === 0) return true;
    for (const [source] of refused) this.refused.add(source);
    const [[first]] = refused;
    const message = `[compactGeom] ${refused.size} compact mesh(es) of entity #${first.expressId}${refused.size > 1 ? ' and others' : ''} have no topology-safe f32 frame; they stay on their pages`;
    if (strict) throw new Error(message);
    console.warn(message);
    return moving.length > 0;
  }

  private move(moving: ReadonlyArray<[MeshData, MeshData]>): void {
    const scene = this.scene;
    // The bucket path registers each mesh again: take the page-time registrations out first.
    this.forget(new Set(moving.map(([, kept]) => kept)));
    const sources = moving.map(([source, kept]) => {
      materializeCompactMesh(kept);
      materializeCompactMesh(source);
      return source;
    });
    // `drain` uploaded them, so its device is known. While a stream or its finalize is under way they
    // join it as fragments; a synchronous rebuild would republish the batch list without the stream's.
    const streaming = this.streaming;
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
    if (failed && !moving.every(([, kept]) => scene.meshDataMap.get(kept.expressId)?.includes(kept))) {
      for (const source of sources) scene.addMeshData(source);
      throw failure;
    }
    // Buckets hold them now (their batches built, or pending like any bucket whose build failed): their page ranges go.
    this.unpage(sources);
    if (failed) throw failure;
  }

  /**
   * Stop drawing the given entities' meshes from pages without moving them
   * anywhere, for a removal: the caller drops their registrations. Queued
   * ones go to the bucket queue, as an f32 mesh still queued would stay queued.
   */
  drop(ids: Iterable<number>): void {
    const selection = { ids: new Set(ids) };
    this.demoteQueued(selection);
    const sources = this.chosen(selection).map(([source]) => source);
    if (sources.length > 0) this.unpage(sources);
  }

  /**
   * The GPU device is lost, and every page with it. The paged meshes are
   * queued again, still compact, and upload to the next device at its first
   * `drain`. Nothing here touches the lost device.
   */
  onDeviceLost(): void {
    if (this.members.size === 0 && this.store.size === 0) return;
    this.requeuePages(false);
  }

  /** Every paged mesh back in the queue, still compact, and no page left. */
  private requeuePages(release: boolean): void {
    this.forget(new Set(this.members.values()));
    this.queue = [...this.members.keys()].concat(this.queue);
    this.members.clear();
    this.byId.clear();
    this.store.destroy(release);
    this.combined = null;
    this.gpu = null;
    this.demotionPages.clear(); // it was asked of pages that no longer exist
    this.refused = new WeakSet(); // judged again on the pages they come back to
    this.trimAfterDrain = true;
    this.scene.bumpPickGeometryRevision();
  }

  /** Drop everything without rebuilding (the Scene is clearing its flat geometry). */
  clear(): void {
    this.store.destroy();
    this.queue = [];
    this.members.clear();
    this.byId.clear();
    this.combined = null;
    this.demotionPages.clear();
    this.refused = new WeakSet();
    this.trimAfterDrain = false;
  }
}
