/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Internal, unqualified Gaussian adapter (#8564). Every asset is packed into one
 * upstream source on the viewer's device and drawn in the viewer's frame. Handles
 * are validated by identity; mutations are serialized and allocate before they
 * commit; anything that awaits re-checks the lifetime epoch so no completion can
 * publish after a loss, teardown or dispose. Readiness never becomes ready here.
 */

import type { NormalizedGaussianAttributes } from './gaussian-attributes.js';
import type { GaussianBackend, GaussianBackendFactory, GaussianBackendScene, GaussianEncodeTarget } from './gaussian-backend.js';
import { assertUsableLifetime, GaussianSplatError, requireDevice } from './gaussian-errors.js';
import { SerialQueue } from './gaussian-serial.js';
import { loadGaussianOps as loadOps, loadLumaBackend } from './gaussian-lazy.js';
import { GaussianDeviceSlot } from './gaussian-device-slot.js';
import type { PackedScene, ShDegree } from './gaussian-pack.js';
import type { SimilarityPlacement } from './gaussian-placement.js';
import { gaussianReadiness, type GaussianReadiness } from './gaussian-readiness.js';
export type { GaussianSplatApi } from './gaussian-types.js';
import type { GaussianSplatAddOptions, GaussianSplatApi, GaussianSplatAssetInput, GaussianSplatBounds, GaussianSplatHandle, GaussianSplatPlacement, GaussianSplatState, GaussianSplatStats } from './gaussian-types.js';
import { anchoredCamera, boundsChange, centreClipFilter, clipKey, encodeResolveOnly, layerStats, sameTranslation, STATES, unionBounds } from './gaussian-frame.js';
import type { PickClipState } from '../pick-types.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';

/** What the layer reads from its Renderer; nothing here is owned by the layer. */
export interface GaussianLayerHost {
  lifetime(): { ready: boolean; lost: boolean; disposed: boolean; generation: number };
  device(): GPUDevice | null;
  adapter(): GPUAdapter | null;
  modelTranslation(modelIndex: number): readonly [number, number, number] | undefined;
  requestRender(): void;
  /** The visible centre union grew. Framing only grows: a shrink would run the tracker's recompute, which drops annotation bounds. */
  boundsGrew(): void;
}

export interface GaussianFrameInput extends Omit<GaussianEncodeTarget, 'depthFormat'> {
  readonly depthFormat?: GPUTextureFormat;
  readonly frame: RelativeToEyeFrame;
  readonly clip: PickClipState | null;
}

interface AssetRecord {
  readonly handle: GaussianSplatHandle;
  readonly slot: number;
  readonly degree: ShDegree;
  attributes: NormalizedGaussianAttributes | null;
  /** Local placement of the committed rows, and the model translation they used. */
  committed: SimilarityPlacement;
  translation: readonly [number, number, number] | undefined;
  /** Latest requested local placement; model re-placement always starts from it. */
  requested: SimilarityPlacement;
  visible: boolean;
  failure: string | null;
  bounds: GaussianSplatBounds;
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

  constructor(private readonly host: GaussianLayerHost, createBackend: GaussianBackendFactory = loadLumaBackend) {
    this.slot = new GaussianDeviceSlot(() => host.adapter(), createBackend);
  }

  readiness(): GaussianReadiness {
    const life = this.host.lifetime();
    return gaussianReadiness(life.ready, life.lost, life.disposed, life.generation, this.slot.upstream);
  }

  async add(input: GaussianSplatAssetInput, options: GaussianSplatAddOptions): Promise<GaussianSplatHandle> {
    if (options?.qualification !== 'internal-unqualified') {
      throw new GaussianSplatError('not-ready', 'Gaussian rendering is unqualified; internal use must pass { qualification: "internal-unqualified" }.');
    }
    const life = this.host.lifetime();
    assertUsableLifetime(life);
    if (!Number.isSafeInteger(input.modelIndex) || input.modelIndex < 0) throw new GaussianSplatError('invalid-placement', 'modelIndex must be a non-negative integer.');
    const checkpoint = this.checkpoint(this.epoch, life.generation, options.signal); // before any await: a clear meanwhile aborts
    const ops = await loadOps();
    checkpoint();
    ops.validateGaussianAttributes(input.attributes);
    const local = ops.decomposeSimilarity(input.placement.matrix);
    const backend = await this.slot.backendFor(requireDevice(this.host.device()));
    checkpoint();
    if (!backend.upstreamReverseZ) throw new GaussianSplatError('upstream-capability-missing', 'Installed @luma.gl/splats lacks reverse-Z ordering (luma.gl #3619).');
    return this.queue.run(async () => {
      checkpoint();
      const { attributes, modelIndex } = input;
      const slot = this.nextSlot++;
      const translation = this.host.modelTranslation(modelIndex);
      const placement = ops.placeInWorld(local, translation);
      const anchor = this.anchor ?? [...placement.translation] as [number, number, number];
      const degree = ops.effectiveShDegree(attributes);
      const live = this.liveRecords();
      const packedDegree = Math.max(degree, ...live.map((r) => r.degree)) as ShDegree;
      const rows = live.reduce((sum, r) => sum + (this.packed?.slices.get(r.slot)?.rows ?? 0), attributes.count);
      ops.assertPackedBudget(rows, packedDegree, requireDevice(this.host.device()).limits);
      const built = await ops.buildPacked(this.packed, live.map((r) => r.slot), { slot, attributes, placement, degree }, anchor, packedDegree, checkpoint);
      const backendNow = await this.slot.backendFor(requireDevice(this.host.device()));
      checkpoint();
      const scene = this.sceneFor(requireDevice(this.host.device()), backendNow);
      try { await scene.replaceSource(built.scene.source); } catch (error) { checkpoint(); throw error; } // a clear or loss outranks the upload error
      try { checkpoint(); } catch (error) { this.abandonUpload(); throw error; } // scene holds rows the layer never published
      const handle: GaussianSplatHandle = Object.freeze({ id: this.nextId++, modelIndex });
      const record: AssetRecord = { handle, slot, degree, attributes, committed: local, translation, requested: local, visible: input.visible ?? true, failure: null, bounds: built.addedBounds! };
      this.records.set(handle, record);
      this.commit(built.scene, anchor, true);
      if (!sameTranslation(translation, this.host.modelTranslation(modelIndex))) this.followModel(record); // moved while packing
      return handle;
    });
  }

  remove(handle: GaussianSplatHandle): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    this.records.delete(handle);
    record.attributes = null;
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
    return layerStats(this.liveRecords(), this.packed?.source, this.uploadedOnCurrentDevice() ? this.slot.scene?.gpuBytes ?? 0 : 0, this.drawnFrames, this.lastEncodeMs);
  }

  clear(): void {
    this.clears++;
    for (const record of this.records.values()) record.attributes = null;
    this.records.clear();
    this.resetPacked();
  }

  /** Renderer teardown drops GPU state: `dispose` invalidates handles, a cleared scene fails assets (reload-required), recovery keeps them pending. */
  release(clearScene: boolean, dispose: boolean): void {
    this.epoch++;
    this.slot.dropAll();
    this.uploadedVersion = -1;
    if (dispose) { this.clear(); return; }
    if (!clearScene) return;
    for (const record of this.records.values()) { record.failure = 'reload-required'; record.attributes = null; }
    this.resetPacked();
  }

  /** Decide before the main pass whether this frame ends in the splat pass (which then resolves MSAA). */
  frameReady(): boolean {
    if (!this.packed || ![...this.records.values()].some((r) => r.visible && !r.failure)) return false;
    if (this.uploadedOnCurrentDevice()) return true;
    this.queueUpload();
    return false;
  }

  /** Record the splat pass after the viewer's main pass; always ends (and resolves) the pass. */
  encode(input: GaussianFrameInput): void {
    const scene = this.slot.scene;
    const target: GaussianEncodeTarget = { ...input, depthFormat: input.depthFormat ?? 'depth24plus-stencil8' };
    if (!scene || !this.anchor || !this.packed) { encodeResolveOnly(target); return; }
    this.updateClip(input.clip);
    const started = performance.now();
    try {
      scene.encode(target, anchoredCamera(input.frame, this.anchor));
      this.drawnFrames++;
    } catch (error) {
      console.error('[Gaussian] splat pass failed; the frame still resolved:', error);
    } finally {
      this.lastEncodeMs = performance.now() - started;
    }
  }

  /**
   * Re-place one asset with the current model translation: an edit applies its own
   * placement (skipped once a newer edit is requested); a model follow keeps the
   * committed placement and never adopts a pending, unvalidated edit. Rows are
   * transformed into fresh arrays first; nothing changes on failure.
   */
  private place(record: AssetRecord, edit: SimilarityPlacement | null): Promise<SimilarityPlacement | null> {
    const epoch = this.epoch;
    const clears = this.clears;
    const stale = () => this.records.get(record.handle) !== record || this.epoch !== epoch || this.clears !== clears || !record.attributes || !!record.failure;
    return this.queue.run(async () => {
      const packed = this.packed;
      const slice = packed?.slices.get(record.slot);
      if (stale() || !packed || !slice || !this.anchor || !record.attributes) return null;
      if (edit && record.requested !== edit) return null;
      const local = edit ?? record.committed;
      const translation = this.host.modelTranslation(record.handle.modelIndex);
      if (local === record.committed && sameTranslation(translation, record.translation)) return local;
      const ops = await loadOps();
      const rows = await ops.transformSlice(record.attributes, ops.placeInWorld(local, translation), this.anchor, packed.source.sphericalHarmonicsDegree, () => {
        if (stale()) throw new GaussianSplatError('aborted', 'Superseded Gaussian placement edit.');
      }).catch((error: unknown) => { if (stale()) return null; throw error; });
      if (!rows || stale() || this.packed !== packed) return null;
      const update = { positions: rows.positions, scales: rows.scales, rotations: rows.rotations, ...(rows.sphericalHarmonics ? { sphericalHarmonics: rows.sphericalHarmonics } : {}) };
      if (this.uploadedOnCurrentDevice()) {
        this.slot.scene!.updateRows(slice.offset, update); // writes GPU rows and the packed CPU copy
      } else {
        ops.writeSliceRows(packed.source, slice, update);
        this.version++; // any in-flight upload carries the old rows; upload again
      }
      Object.assign(record, { committed: local, translation, bounds: rows.bounds });
      this.clipKey = '';
      this.applyFilter(true);
      return local;
    });
  }

  /** Follow a model translation; an asset that can no longer stay inside the anchor envelope fails visibly. */
  private followModel(record: AssetRecord): void {
    this.place(record, null).catch((error: unknown) => {
      if (this.records.get(record.handle) !== record || record.failure) return;
      console.error('[Gaussian] asset could not follow its model translation:', error);
      record.failure = error instanceof GaussianSplatError ? error.code : 'reload-required';
      record.attributes = null;
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
      const degree = Math.max(0, ...live.map((r) => r.degree)) as ShDegree;
      const built = await (await loadOps()).buildPacked(packed, live.map((r) => r.slot), null, this.anchor, degree, check);
      // Upload before publishing: the previous source keeps drawing (removed slots filtered) meanwhile.
      const uploaded = this.uploadedOnCurrentDevice() ? this.slot.scene : null;
      if (uploaded) { try { await uploaded.replaceSource(built.scene.source); } catch (error) { check(); throw error; } }
      try { check(); } catch (error) { if (uploaded) this.abandonUpload(); throw error; }
      this.commit(built.scene, this.anchor!, uploaded !== null && this.slot.scene === uploaded);
    }).catch((error: unknown) => {
      if (error instanceof GaussianSplatError && error.code === 'aborted') return; // superseded by a clear, loss or newer source
      console.error('[Gaussian] compaction failed; removed rows stay hidden until the next repack:', error);
    });
  }

  /** Publish a new packed source. `uploaded`: the current scene already holds it. */
  private commit(scene: PackedScene, anchor: [number, number, number], uploaded: boolean): void {
    this.packed = scene;
    this.anchor = anchor;
    this.version++;
    this.uploadedVersion = uploaded ? this.version : -1;
    this.clipKey = '';
    this.applyFilter(true);
  }

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
      if (!device || !packed || this.epoch !== epoch || this.uploadedOnCurrentDevice()) return;
      const stale = () => this.epoch !== epoch || this.packed !== packed || this.version !== version || this.host.device() !== device;
      const backend = await this.slot.backendFor(device);
      if (stale()) return; // cleared, lost or superseded while the backend loaded: create and upload nothing
      const scene = this.sceneFor(device, backend);
      await scene.replaceSource(packed.source);
      if (stale() || this.slot.scene !== scene) { if (this.slot.scene === scene) this.abandonUpload(); return; }
      this.uploadedVersion = version;
      this.applyFilter();
    }).catch((error: unknown) => {
      this.uploadQueued = false;
      if (this.epoch !== epoch || this.packed !== attempted) return; // superseded by loss, clear or a newer source
      console.error('[Gaussian] upload failed; assets need a reload:', error);
      for (const record of this.records.values()) { record.failure = 'reload-required'; record.attributes = null; }
      this.resetPacked();
    });
  }

  private applyFilter(boundsChanged = false): void {
    if (boundsChanged) this.notifyBounds();
    this.host.requestRender();
    const include = new Set([...this.records.values()].filter((r) => r.visible && !r.failure).map((r) => r.slot));
    this.slot.scene?.setFilter(include, centreClipFilter(this.clipState, this.packed?.source, this.anchor));
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
    if (change.grew) this.host.boundsGrew();
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
