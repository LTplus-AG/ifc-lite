/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Internal, unqualified Gaussian adapter (#8564). Identity-validated handles,
 * serialized mutations and epoch checks prevent publication after teardown.
 * No CPU copy of asset rows is kept (#9018, see gaussian-repack). */

import { translateGaussianFrame } from './gaussian-frame-translation.js';
import type { GaussianBackend, GaussianBackendFactory, GaussianBackendScene, GaussianEncodeTarget } from './gaussian-backend.js';
import { assertUsableLifetime, GaussianSplatError, requireDevice } from './gaussian-errors.js';
import { SerialQueue } from './gaussian-serial.js';
import { loadGaussianOps as loadOps, loadLumaBackend } from './gaussian-lazy.js';
import { GaussianDeviceSlot } from './gaussian-device-slot.js';
import type { PackedScene } from './gaussian-pack.js';
import { gaussianAssetRows } from './gaussian-rows.js';
import { uploadRepack, type GaussianAssetRecord as AssetRecord } from './gaussian-repack.js';
import type { SimilarityPlacement } from './gaussian-placement.js';
import { gaussianReadiness, type GaussianReadiness } from './gaussian-readiness.js';
export type { GaussianSplatApi } from './gaussian-types.js';
import type { GaussianSplatAddOptions, GaussianSplatApi, GaussianSplatAssetInput, GaussianSplatBounds, GaussianSplatHandle, GaussianSplatPlacement, GaussianSplatRowsInput, GaussianSplatState, GaussianSplatStats } from './gaussian-types.js';
import { anchoredCamera, boundsChange, centreClipFilter, clipKey, layerStats, sameTranslation, STATES, unionBounds } from './gaussian-frame.js';
import { GaussianGlassComposer, type DeferredPassRecorder, type GaussianCompositionMode, type GlassFrameInput, type GlassVisibility } from './gaussian-glass-frame.js';
import type { PickClipState } from '../pick-types.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';
/** What the layer reads from its Renderer; nothing here is owned by the layer. */
export interface GaussianLayerHost {
  lifetime(): { ready: boolean; lost: boolean; disposed: boolean; generation: number };
  device(): GPUDevice | null;
  adapter(): GPUAdapter | null;
  modelTranslation(modelIndex: number): readonly [number, number, number] | undefined;
  requestRender(): void;
  /** The current visible centre union changed; it may only widen the camera's depth range, never model or fit bounds. */
  extentChanged(visible: GaussianSplatBounds | null): void;
}

export interface GaussianFrameInput extends Omit<GaussianEncodeTarget, 'depthFormat'>, GlassFrameInput {
  readonly depthFormat?: GPUTextureFormat;
  readonly frame: RelativeToEyeFrame;
  readonly clip: PickClipState | null;
}


export class GaussianSplatLayer implements GaussianSplatApi {
  private readonly records = new Map<GaussianSplatHandle, AssetRecord>();
  private packed: PackedScene | null = null;
  private anchor: [number, number, number] | null = null;
  private version = 0;
  private uploadedVersion = -1;
  private nextId = 1;
  private nextSlot = 1;
  private epoch = 0;
  private clears = 0;
  private readonly queue = new SerialQueue();
  private uploadQueued = false;
  private readonly slot: GaussianDeviceSlot;
  private clipKey = '';
  private clipState: PickClipState | null = null;
  private notifiedBounds: GaussianSplatBounds | null = null;
  private drawnFrames = 0;
  private lastEncodeMs = 0;
  private readonly glass = new GaussianGlassComposer(() => this.host.requestRender());

  constructor(private readonly host: GaussianLayerHost, createBackend: GaussianBackendFactory = loadLumaBackend) {
    this.slot = new GaussianDeviceSlot(() => host.adapter(), createBackend);
  }

  readiness(): GaussianReadiness {
    const life = this.host.lifetime();
    return gaussianReadiness(life.ready, life.lost, life.disposed, life.generation, this.slot.upstream);
  }

  async add(input: GaussianSplatAssetInput | GaussianSplatRowsInput, options: GaussianSplatAddOptions): Promise<GaussianSplatHandle> {
    if (options?.qualification !== 'internal-unqualified') {
      throw new GaussianSplatError('not-ready', 'Gaussian rendering is unqualified; internal use must pass { qualification: "internal-unqualified" }.');
    }
    const life = this.host.lifetime();
    assertUsableLifetime(life);
    if (!Number.isSafeInteger(input.modelIndex) || input.modelIndex < 0) throw new GaussianSplatError('invalid-placement', 'modelIndex must be a non-negative integer.');
    const checkpoint = this.checkpoint(this.epoch, life.generation, options.signal); // before any await: a clear meanwhile aborts
    const rows = gaussianAssetRows(input);
    const ops = await loadOps();
    checkpoint();
    const local = ops.decomposeSimilarity(input.placement.matrix);
    const backend = await this.slot.backendFor(requireDevice(this.host.device()));
    checkpoint();
    if (!backend.upstreamReverseZ) throw new GaussianSplatError('upstream-capability-missing', 'Installed @luma.gl/splats lacks reverse-Z ordering (luma.gl #3619).');
    return this.queue.run(async () => {
      checkpoint();
      const { modelIndex } = input, slot = this.nextSlot++;
      const translation = this.host.modelTranslation(modelIndex);
      const placement = ops.placeInWorld(local, translation);
      const anchor = this.anchor ?? [...placement.translation] as [number, number, number];
      const handle: GaussianSplatHandle = Object.freeze({ id: this.nextId, modelIndex });
      const record: AssetRecord = {
        handle, slot, degree: rows.effectiveShDegree, count: rows.count, rows, committed: local, translation, requested: local,
        visible: input.visible ?? true, failure: null, bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      };
      const built = await this.repack([...this.liveRecords(), record], new Map([[record, placement]]), anchor, checkpoint);
      try { checkpoint(); } catch (error) { this.abandonUpload(); throw error; } // scene holds rows the layer never published
      this.nextId++;
      this.records.set(handle, record);
      this.commit(built.scene, anchor, true, built.bounds); // sets record.bounds
      if (!sameTranslation(translation, this.host.modelTranslation(modelIndex))) this.followModel(record); // moved while packing
      return handle;
    });
  }

  remove(handle: GaussianSplatHandle): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    this.records.delete(handle);
    record.rows = null;
    this.applyFilter(true);
    this.compact();
    return true;
  }

  setVisible(handle: GaussianSplatHandle, visible: boolean): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    record.visible = visible;
    this.applyFilter(true);
    return true;
  }

  async setPlacement(handle: GaussianSplatHandle, input: GaussianSplatPlacement): Promise<boolean> {
    if (!this.records.get(handle) || this.records.get(handle)?.failure) return false;
    const local = (await loadOps()).decomposeSimilarity(input.matrix);
    const record = this.records.get(handle);
    if (!record || record.failure) return false;
    record.requested = local;
    try {
      return (await this.place(record, local)) === local; // false when superseded or made stale
    } catch (error) {
      if (record.requested === local) record.requested = record.committed; // the committed rows never changed
      throw error;
    }
  }
  /** A scene frame change moves the anchor too, preserving the f32 envelope. */
  translateFrame(delta: readonly [number, number, number]): Promise<boolean> {
    const epoch = this.epoch, clears = this.clears;
    return this.queue.run(async () => {
      if (this.epoch !== epoch || this.clears !== clears || !this.anchor) return false;
      this.anchor = translateGaussianFrame(this.records.values(), this.anchor, delta);
      this.clipKey = '';
      this.applyFilter(true);
      return true;
    });
  }

  /** Re-place every asset of `modelIndex` after the renderer's model translation changed. */
  setModelTranslation(modelIndex: number): void {
    for (const record of this.records.values()) if (record.handle.modelIndex === modelIndex && !record.failure) this.followModel(record);
  }

  getBounds(handle?: GaussianSplatHandle): GaussianSplatBounds | null {
    const records = handle ? [this.records.get(handle)] : [...this.records.values()].filter((r) => r.visible);
    return unionBounds(records.filter((r): r is AssetRecord => !!r && !r.failure).map((r) => r.bounds));
  }

  getState(handle: GaussianSplatHandle): GaussianSplatState {
    const record = this.records.get(handle);
    if (!record) return STATES.invalid;
    if (record.failure) return { state: 'failed', reason: record.failure };
    return this.uploadedOnCurrentDevice() ? STATES.resident : STATES.pending;
  }

  getStats(): GaussianSplatStats {
    return layerStats(this.liveRecords(), this.packed, this.uploadedOnCurrentDevice() ? this.slot.scene?.gpuBytes ?? 0 : 0, this.drawnFrames, this.lastEncodeMs, this.glass.report);
  }

  setCompositionMode(mode: GaussianCompositionMode): void { this.glass.setMode(mode); }

  clear(): void {
    this.clears++;
    for (const record of this.records.values()) record.rows = null;
    this.records.clear();
    this.resetPacked();
  }

  /** Renderer teardown drops GPU state: `dispose` invalidates handles, a cleared scene fails assets (reload-required), recovery keeps them pending. */
  release(clearScene: boolean, dispose: boolean): void {
    this.epoch++;
    this.slot.dropAll(); this.glass.release();
    this.uploadedVersion = -1;
    if (dispose) { this.clear(); return; }
    if (!clearScene) return;
    for (const record of this.records.values()) { record.failure = 'reload-required'; record.rows = null; }
    this.resetPacked();
  }
  /** Decide before the main pass whether this frame ends in the splat pass (which then resolves MSAA). */
  captureDiagnostics(): Record<string, unknown> | null { return this.slot.scene?.captureDiagnostics?.() ?? null; }
  frameReady(): boolean {
    if (!this.packed || ![...this.records.values()].some((r) => r.visible && !r.failure)) return false;
    if (this.uploadedOnCurrentDevice()) return true;
    this.queueUpload();
    return false;
  }

  /** #8564 split: `glassRecorder` holds a splat frame's transparent IFC (call before its main pass); `submitted` reads the layer count back. */
  glassRecorder(visibility: GlassVisibility): DeferredPassRecorder { return this.glass.recorder(requireDevice(this.host.device()), this.slot.depthInterval, visibility); }
  submitted(): void { this.glass.submitted(); }
  /** Record the splat passes after the viewer's main pass (and held transparent IFC); always ends with the MSAA resolve. */
  encode(input: GaussianFrameInput): void {
    const scene = this.slot.scene;
    const target: GaussianEncodeTarget = { ...input, depthFormat: input.depthFormat ?? 'depth24plus-stencil8' };
    const anchor = scene && this.packed ? this.anchor : null;
    if (anchor) this.updateClip(input.clip);
    const started = performance.now();
    if (this.glass.encode(anchor ? scene : null, target, anchor ? anchoredCamera(input.frame, anchor) : null, input) && anchor) this.drawnFrames++;
    this.lastEncodeMs = performance.now() - started;
  }

  /** Re-place by reading the asset's rows again; superseded edits and failed transforms never commit.
   * Model following uses committed placement, never a pending edit. */
  private place(record: AssetRecord, edit: SimilarityPlacement | null): Promise<SimilarityPlacement | null> {
    const epoch = this.epoch;
    const clears = this.clears;
    const stale = () => this.records.get(record.handle) !== record || this.epoch !== epoch || this.clears !== clears || !record.rows || !!record.failure;
    return this.queue.run(async () => {
      const packed = this.packed;
      if (stale() || !packed || !packed.slices.has(record.slot) || !this.anchor || !record.rows) return null;
      if (edit && record.requested !== edit) return null;
      const local = edit ?? record.committed;
      const translation = this.host.modelTranslation(record.handle.modelIndex);
      if (local === record.committed && sameTranslation(translation, record.translation)) return local;
      const ops = await loadOps();
      const placement = ops.placeInWorld(local, translation);
      const check = () => { if (stale() || this.packed !== packed) throw new GaussianSplatError('aborted', 'Superseded Gaussian placement edit.'); };
      const settle = <T>(work: Promise<T>) => work.catch((error: unknown) => { if (stale() || this.packed !== packed) return null; throw error; });
      if (!this.host.device() || this.host.lifetime().lost) {
        // No device: validate and bound the placement from the source. The version bump makes any in-flight
        // upload stale, so the next upload (recovery, or a device that arrived meanwhile) reads it.
        const bounds = await settle(ops.placedBounds(record.rows, placement, this.anchor, record.degree, check));
        if (!bounds || stale() || this.packed !== packed) return null;
        Object.assign(record, { committed: local, translation, bounds });
        this.version++;
        this.clipKey = '';
        this.applyFilter(true);
        return local;
      }
      const anchor = this.anchor;
      const built = await settle(this.repack(this.liveRecords(), new Map([[record, placement]]), anchor, check));
      if (!built || stale() || this.packed !== packed) { if (built) this.abandonUpload(); return null; }
      Object.assign(record, { committed: local, translation });
      this.commit(built.scene, anchor, true, built.bounds);
      return local;
    });
  }

  /** Follow a model translation; an asset that can no longer stay inside the anchor envelope fails visibly. */
  private followModel(record: AssetRecord): void {
    this.place(record, null).catch((error: unknown) => {
      if (this.records.get(record.handle) !== record || record.failure) return;
      console.error('[Gaussian] asset could not follow its model translation:', error);
      record.failure = error instanceof GaussianSplatError ? error.code : 'reload-required';
      record.rows = null;
      this.applyFilter(true);
    });
  }

  private compact(): void {
    const epoch = this.epoch;
    const clears = this.clears;
    void this.queue.run(async () => {
      const packed = this.packed;
      const check = () => { if (this.epoch !== epoch || this.clears !== clears || this.packed !== packed) throw new GaussianSplatError('aborted', 'Gaussian compaction superseded.'); };
      if (this.epoch !== epoch || this.clears !== clears || !packed || !this.anchor) return;
      const live = this.liveRecords();
      if (live.length === 0) { this.resetPacked(); return; }
      // Nothing drawn on this device: the next upload reads the remaining assets anyway.
      if (!this.uploadedOnCurrentDevice()) return;
      const anchor = this.anchor;
      // Upload before publishing: the previous rows keep drawing (removed slots filtered) meanwhile.
      const built = await this.repack(live, new Map(), anchor, check);
      try { check(); } catch (error) { this.abandonUpload(); throw error; }
      this.commit(built.scene, anchor, true, built.bounds);
    }).catch((error: unknown) => {
      if (error instanceof GaussianSplatError && error.code === 'aborted') return; // superseded by a clear, loss or newer source
      console.error('[Gaussian] compaction failed; removed rows stay hidden until the next repack:', error);
    });
  }

  /** Upload a new pack of `live` on the current device (see uploadRepack); on failure the backend has released it. */
  private async repack(live: readonly AssetRecord[], reads: ReadonlyMap<AssetRecord, SimilarityPlacement>, anchor: readonly [number, number, number], check: () => void) {
    const ops = await loadOps();
    check();
    const device = requireDevice(this.host.device());
    const backend = await this.slot.backendFor(device);
    check();
    const previous = this.uploadedOnCurrentDevice() ? this.packed : null;
    return uploadRepack(ops, device, this.sceneFor(device, backend), previous, live, reads, anchor, check);
  }

  /** Publish a new packed source. `uploaded`: the current scene already holds it. */
  private commit(scene: PackedScene, anchor: readonly [number, number, number], uploaded: boolean, bounds?: ReadonlyMap<number, GaussianSplatBounds>): void {
    for (const record of this.records.values()) { const read = bounds?.get(record.slot); if (read) record.bounds = read; }
    this.packed = scene;
    this.anchor = [...anchor] as [number, number, number];
    this.version++;
    this.uploadedVersion = uploaded ? this.version : -1;
    this.clipKey = '';
    this.applyFilter(true);
  }

  /** Upload the published assets on this device (first draw, recovery, an abandoned upload) by reading their rows again. */
  private queueUpload(): void {
    if (this.uploadQueued) return;
    this.uploadQueued = true;
    const epoch = this.epoch;
    let attempted: PackedScene | null = null;
    void this.queue.run(async () => {
      this.uploadQueued = false;
      const device = this.host.device();
      const packed = attempted = this.packed;
      const version = this.version;
      const anchor = this.anchor;
      if (!device || !packed || !anchor || this.epoch !== epoch || this.uploadedOnCurrentDevice()) return;
      const stale = () => this.epoch !== epoch || this.packed !== packed || this.version !== version || this.host.device() !== device;
      const check = () => { if (stale()) throw new GaussianSplatError('aborted', 'Gaussian upload superseded.'); };
      let built;
      try { built = await this.repack(this.liveRecords(), new Map(), anchor, check); }
      catch (error) { if (stale()) return; throw error; } // cleared, lost or superseded: create and upload nothing more
      if (stale()) { this.abandonUpload(); return; }
      attempted = built.scene;
      this.commit(built.scene, anchor, true, built.bounds);
    }).catch((error: unknown) => {
      this.uploadQueued = false;
      if (this.epoch !== epoch || (this.packed !== attempted)) return; // superseded by loss, clear or a newer source
      console.error('[Gaussian] upload failed; assets need a reload:', error);
      for (const record of this.records.values()) { record.failure = 'reload-required'; record.rows = null; }
      this.resetPacked();
    });
  }

  private applyFilter(boundsChanged = false): void {
    if (boundsChanged) this.notifyBounds();
    this.host.requestRender();
    const include = new Set([...this.records.values()].filter((r) => r.visible && !r.failure).map((r) => r.slot));
    this.slot.scene?.setFilter(include, centreClipFilter(this.clipState, this.packed?.sort, this.anchor));
  }

  private updateClip(clip: PickClipState | null): void {
    const key = clipKey(clip);
    if (key === this.clipKey) return;
    this.clipKey = key;
    this.clipState = key === 'none' ? null : clip;
    this.applyFilter();
  }

  private uploadedOnCurrentDevice(): boolean {
    const life = this.host.lifetime();
    const device = this.host.device();
    return !life.lost && !life.disposed && this.slot.owns(device) && this.uploadedVersion === this.version && this.packed !== null;
  }

  private sceneFor(device: GPUDevice, backend: GaussianBackend): GaussianBackendScene {
    const { scene, created } = this.slot.sceneFor(device, backend);
    if (created) { this.uploadedVersion = -1; this.clipKey = ''; }
    return scene;
  }

  private resetPacked(): void {
    this.packed = null;
    this.anchor = null;
    this.version++;
    this.slot.dropScene();
    this.uploadedVersion = -1;
    this.notifyBounds();
    this.host.requestRender();
  }

  private notifyBounds(): void {
    const change = boundsChange(this.notifiedBounds, this.getBounds());
    if (!change) return;
    this.notifiedBounds = change.next;
    this.host.extentChanged(change.next);
  }

  /** The current scene holds rows that were never published: withdraw residency, and release it if nothing is packed. */
  private abandonUpload(): void {
    this.uploadedVersion = -1;
    if (!this.packed) this.slot.dropScene();
  }

  private liveRecords(): AssetRecord[] {
    return [...this.records.values()].filter((r) => !r.failure);
  }

  private checkpoint(epoch: number, generation: number, signal?: AbortSignal): () => void {
    const clears = this.clears;
    return () => {
      const life = this.host.lifetime();
      if (life.disposed) throw new GaussianSplatError('disposed', 'The renderer was destroyed.');
      if (this.epoch !== epoch || life.lost || life.generation !== generation) throw new GaussianSplatError('lost', 'The GPU lifetime changed during the Gaussian add.');
      if (signal?.aborted || this.clears !== clears) throw new GaussianSplatError('aborted', 'Gaussian add was aborted or cleared.');
    };
  }
}
