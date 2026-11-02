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
import { GaussianSplatError } from './gaussian-errors.js';
import { assertPackedBudget, buildPacked, effectiveShDegree, placeInWorld, transformSlice, validateGaussianAttributes, type PackedScene, type ShDegree } from './gaussian-pack.js';
import { decomposeSimilarity, type SimilarityPlacement } from './gaussian-placement.js';
import { gaussianReadiness, type GaussianReadiness, type GaussianUpstreamStatus } from './gaussian-readiness.js';
export type { GaussianSplatApi } from './gaussian-types.js';
import type { GaussianSplatAddOptions, GaussianSplatApi, GaussianSplatAssetInput, GaussianSplatBounds, GaussianSplatHandle, GaussianSplatPlacement, GaussianSplatState, GaussianSplatStats } from './gaussian-types.js';
import { anchoredCamera, centreClipFilter, clipKey, encodeResolveOnly, packedCpuBytes, unionBounds } from './gaussian-frame.js';
import type { PickClipState } from '../pick-types.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';

/** What the layer reads from its Renderer; nothing here is owned by the layer. */
export interface GaussianLayerHost {
  lifetime(): { ready: boolean; lost: boolean; disposed: boolean; generation: number };
  device(): GPUDevice | null;
  adapter(): GPUAdapter | null;
  modelTranslation(modelIndex: number): readonly [number, number, number] | undefined;
  requestRender(): void;
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
  placement: SimilarityPlacement;
  visible: boolean;
  failure: string | null;
  bounds: GaussianSplatBounds;
  editToken: number;
}

const INVALID: GaussianSplatState = Object.freeze({ state: 'invalid' });
const PENDING: GaussianSplatState = Object.freeze({ state: 'pending' });
const RESIDENT: GaussianSplatState = Object.freeze({ state: 'resident' });
const loadLumaBackend: GaussianBackendFactory = async (...args) => (await import('./gaussian-luma-backend.js')).createLumaGaussianBackend(...args);

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
  private queue: Promise<unknown> = Promise.resolve();
  private uploadQueued = false;
  private backend: { device: GPUDevice; promise: Promise<GaussianBackend> } | null = null;
  private scene: { device: GPUDevice; scene: GaussianBackendScene } | null = null;
  private upstream: GaussianUpstreamStatus = 'unknown';
  private clipKey = '';
  private clipState: PickClipState | null = null;
  private drawnFrames = 0;
  private lastEncodeMs = 0;

  constructor(private readonly host: GaussianLayerHost, private readonly createBackend: GaussianBackendFactory = loadLumaBackend) {}

  readiness(): GaussianReadiness {
    const life = this.host.lifetime();
    return gaussianReadiness(life.ready, life.lost, life.disposed, life.generation, this.upstream);
  }

  async add(input: GaussianSplatAssetInput, options: GaussianSplatAddOptions): Promise<GaussianSplatHandle> {
    if (options?.qualification !== 'internal-unqualified') {
      throw new GaussianSplatError('not-ready', 'Gaussian rendering is unqualified; internal use must pass { qualification: "internal-unqualified" }.');
    }
    const life = this.usableLifetime();
    validateGaussianAttributes(input.attributes);
    if (!Number.isSafeInteger(input.modelIndex) || input.modelIndex < 0) throw new GaussianSplatError('invalid-placement', 'modelIndex must be a non-negative integer.');
    const local = decomposeSimilarity(input.placement.matrix);
    const checkpoint = this.checkpoint(this.epoch, life.generation, options.signal);
    checkpoint();
    const backend = await this.backendFor(this.currentDevice());
    checkpoint();
    if (!backend.upstreamReverseZ) throw new GaussianSplatError('upstream-capability-missing', 'Installed @luma.gl/splats lacks reverse-Z ordering (luma.gl #3619).');
    return this.serialized(async () => {
      checkpoint();
      const { attributes, modelIndex } = input;
      const slot = this.nextSlot++;
      const placement = placeInWorld(local, this.host.modelTranslation(modelIndex));
      const anchor = this.anchor ?? [...placement.translation] as [number, number, number];
      const degree = effectiveShDegree(attributes);
      const packedDegree = Math.max(degree, this.packed?.source.sphericalHarmonicsDegree ?? 0) as ShDegree;
      const rows = attributes.count + (this.packed?.source.opacities.length ?? 0);
      assertPackedBudget(rows, packedDegree, this.currentDevice().limits);
      const built = await buildPacked(this.packed, this.liveSlots(), { slot, attributes, placement, degree }, anchor, packedDegree, checkpoint);
      const scene = this.sceneFor(this.currentDevice(), await this.backendFor(this.currentDevice()));
      await scene.replaceSource(built.scene.source);
      try { checkpoint(); } catch (error) { this.uploadedVersion = -1; throw error; } // scene holds rows the layer never published
      const handle: GaussianSplatHandle = Object.freeze({ id: this.nextId++, modelIndex });
      this.records.set(handle, { handle, slot, degree, attributes, placement: local, visible: input.visible ?? true, failure: null, bounds: built.addedBounds!, editToken: 0 });
      this.commit(built.scene, anchor, true);
      return handle;
    });
  }

  remove(handle: GaussianSplatHandle): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    this.records.delete(handle);
    record.attributes = null;
    this.applyFilter();
    this.compact();
    return true;
  }

  setVisible(handle: GaussianSplatHandle, visible: boolean): boolean {
    const record = this.records.get(handle);
    if (!record) return false;
    record.visible = visible;
    this.applyFilter();
    return true;
  }

  async setPlacement(handle: GaussianSplatHandle, input: GaussianSplatPlacement): Promise<boolean> {
    const record = this.records.get(handle);
    if (!record || record.failure) return false;
    const local = decomposeSimilarity(input.matrix);
    const token = ++record.editToken;
    return this.replace(record, token, local);
  }

  /** Re-place every asset of `modelIndex` after the renderer's model translation changed. */
  setModelTranslation(modelIndex: number): void {
    for (const record of this.records.values()) {
      if (record.handle.modelIndex !== modelIndex || record.failure) continue;
      this.replace(record, ++record.editToken, record.placement).catch((error: unknown) => console.error('[Gaussian] re-placement after a model translation failed:', error));
    }
  }

  getBounds(handle?: GaussianSplatHandle): GaussianSplatBounds | null {
    const records = handle ? [this.records.get(handle)] : [...this.records.values()].filter((r) => r.visible);
    return unionBounds(records.filter((r): r is AssetRecord => !!r && !r.failure).map((r) => r.bounds));
  }

  getState(handle: GaussianSplatHandle): GaussianSplatState {
    const record = this.records.get(handle);
    if (!record) return INVALID;
    if (record.failure) return { state: 'failed', reason: record.failure };
    return this.uploadedOnCurrentDevice() ? RESIDENT : PENDING;
  }

  getStats(): GaussianSplatStats {
    const live = [...this.records.values()].filter((r) => !r.failure);
    const source = this.packed?.source;
    const cpuBytes = packedCpuBytes(source);
    return {
      assets: live.length, splats: source?.opacities.length ?? 0,
      visibleAssetSplats: live.filter((r) => r.visible).reduce((sum, r) => sum + (r.attributes?.count ?? 0), 0),
      cpuBytes, gpuBytes: this.uploadedOnCurrentDevice() ? this.scene?.scene.gpuBytes ?? 0 : 0,
      drawnFrames: this.drawnFrames, lastEncodeMs: this.lastEncodeMs,
      composition: 'over-transparent-approximate', clipping: 'centre',
    };
  }

  clear(): void {
    this.clears++;
    for (const record of this.records.values()) record.attributes = null;
    this.records.clear();
    this.resetPacked();
  }

  /**
   * Renderer teardown. `dispose`: the renderer is destroyed, every handle becomes invalid.
   * Otherwise GPU state is dropped; `clearScene` (scene cleared) fails every asset as
   * reload-required, while a recovery teardown keeps them pending for re-upload.
   */
  release(clearScene: boolean, dispose: boolean): void {
    this.epoch++;
    this.dropDeviceState();
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
    const scene = this.scene?.scene;
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

  private replace(record: AssetRecord, token: number, local: SimilarityPlacement): Promise<boolean> {
    const epoch = this.epoch;
    const clears = this.clears;
    const stale = () => this.records.get(record.handle) !== record || record.editToken !== token || this.epoch !== epoch || this.clears !== clears || !record.attributes;
    return this.serialized(async () => {
      const packed = this.packed;
      const slice = packed?.slices.get(record.slot);
      if (stale() || !packed || !slice || !this.anchor || !record.attributes) return false;
      const placement = placeInWorld(local, this.host.modelTranslation(record.handle.modelIndex));
      const rows = await transformSlice(record.attributes, placement, this.anchor, packed.source.sphericalHarmonicsDegree, () => {
        if (stale()) throw new GaussianSplatError('aborted', 'Superseded Gaussian placement edit.');
      }).catch((error: unknown) => { if (stale()) return null; throw error; });
      if (!rows || stale() || this.packed !== packed) return false;
      const update = { positions: rows.positions, scales: rows.scales, rotations: rows.rotations, ...(rows.sphericalHarmonics ? { sphericalHarmonics: rows.sphericalHarmonics } : {}) };
      if (this.uploadedOnCurrentDevice()) {
        this.scene!.scene.updateRows(slice.offset, update); // writes GPU rows and the packed CPU copy
      } else {
        const source = packed.source;
        source.positions.set(update.positions, slice.offset * 3);
        source.scales.set(update.scales, slice.offset * 3);
        source.rotations.set(update.rotations, slice.offset * 4);
        if (update.sphericalHarmonics) source.sphericalHarmonics?.set(update.sphericalHarmonics, (update.sphericalHarmonics.length / slice.rows) * slice.offset);
        this.version++; // any in-flight upload carries the old rows; upload again
      }
      record.placement = local;
      record.bounds = rows.bounds;
      this.clipKey = '';
      this.applyFilter();
      return true;
    });
  }

  private compact(): void {
    const epoch = this.epoch;
    void this.serialized(async () => {
      if (this.epoch !== epoch || !this.packed) return;
      const live = this.liveSlots();
      if (live.length === 0) { this.resetPacked(); return; }
      const degree = Math.max(0, ...[...this.records.values()].filter((r) => !r.failure).map((r) => r.degree)) as ShDegree;
      const built = await buildPacked(this.packed, live, null, this.anchor!, degree, () => {
        if (this.epoch !== epoch) throw new GaussianSplatError('lost', 'Gaussian compaction superseded.');
      });
      this.commit(built.scene, this.anchor!, false);
    }).catch((error: unknown) => { if (!(error instanceof GaussianSplatError)) console.error('[Gaussian] compaction failed:', error); });
  }

  /** Publish a new packed source. `uploaded`: the current scene already holds it. */
  private commit(scene: PackedScene, anchor: [number, number, number], uploaded: boolean): void {
    this.packed = scene;
    this.anchor = anchor;
    this.version++;
    this.uploadedVersion = uploaded ? this.version : -1;
    this.clipKey = '';
    this.applyFilter();
  }

  private queueUpload(): void {
    if (this.uploadQueued) return;
    this.uploadQueued = true;
    const epoch = this.epoch;
    void this.serialized(async () => {
      this.uploadQueued = false;
      const device = this.host.device();
      const packed = this.packed;
      const version = this.version;
      if (!device || !packed || this.epoch !== epoch || this.uploadedOnCurrentDevice()) return;
      const scene = this.sceneFor(device, await this.backendFor(device));
      await scene.replaceSource(packed.source);
      if (this.epoch !== epoch || this.scene?.scene !== scene || this.packed !== packed || this.version !== version) return;
      this.uploadedVersion = version;
      this.applyFilter();
    }).catch((error: unknown) => {
      this.uploadQueued = false;
      if (this.epoch !== epoch) return;
      console.error('[Gaussian] upload failed; assets need a reload:', error);
      for (const record of this.records.values()) { record.failure = 'reload-required'; record.attributes = null; }
      this.resetPacked();
    });
  }

  private applyFilter(): void {
    this.host.requestRender();
    const include = new Set([...this.records.values()].filter((r) => r.visible && !r.failure).map((r) => r.slot));
    this.scene?.scene.setFilter(include, centreClipFilter(this.clipState, this.packed?.source, this.anchor));
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
    return !life.lost && !life.disposed && device !== null && this.scene?.device === device && this.uploadedVersion === this.version && this.packed !== null;
  }

  private backendFor(device: GPUDevice): Promise<GaussianBackend> {
    if (this.backend?.device !== device) {
      const promise = this.createBackend(device, this.host.adapter(), (error) => console.error('[Gaussian] upstream WebGPU error:', error))
        .catch((error: unknown) => {
          throw error instanceof GaussianSplatError ? error : new GaussianSplatError('upstream-capability-missing', `Upstream Gaussian renderer failed to load: ${String(error)}`);
        });
      promise.then((backend) => { if (this.backend?.promise === promise) this.upstream = backend.upstreamReverseZ ? 'available' : 'missing'; },
        () => { if (this.backend?.promise === promise) this.upstream = 'missing'; });
      this.backend = { device, promise };
    }
    return this.backend.promise;
  }

  private sceneFor(device: GPUDevice, backend: GaussianBackend): GaussianBackendScene {
    if (this.scene?.device !== device) {
      this.scene?.scene.destroy();
      this.scene = { device, scene: backend.createScene() };
      this.uploadedVersion = -1;
      this.clipKey = '';
    }
    return this.scene.scene;
  }

  private dropDeviceState(): void {
    this.scene?.scene.destroy(); // only upstream allocations; never the viewer device or attachments
    this.scene = null;
    this.backend = null;
    this.uploadedVersion = -1;
  }

  private resetPacked(): void {
    this.packed = null;
    this.anchor = null;
    this.version++;
    this.scene?.scene.destroy();
    this.scene = null;
    this.uploadedVersion = -1;
    this.host.requestRender();
  }

  private liveSlots(): number[] {
    return [...this.records.values()].filter((r) => !r.failure).map((r) => r.slot);
  }

  private usableLifetime() {
    const life = this.host.lifetime();
    if (life.disposed) throw new GaussianSplatError('disposed', 'The renderer was destroyed.');
    if (life.lost) throw new GaussianSplatError('lost', 'The GPU device is lost.');
    if (!life.ready) throw new GaussianSplatError('not-ready', 'The renderer is not initialized.');
    return life;
  }

  private currentDevice(): GPUDevice {
    const device = this.host.device();
    if (!device) throw new GaussianSplatError('lost', 'No current GPU device.');
    return device;
  }

  private checkpoint(epoch: number, generation: number, signal?: AbortSignal): () => void {
    const clears = this.clears;
    return () => {
      if (signal?.aborted || this.clears !== clears) throw new GaussianSplatError('aborted', 'Gaussian add was aborted or cleared.');
      const life = this.host.lifetime();
      if (life.disposed) throw new GaussianSplatError('disposed', 'The renderer was destroyed.');
      if (this.epoch !== epoch || life.lost || life.generation !== generation) throw new GaussianSplatError('lost', 'The GPU lifetime changed during the Gaussian add.');
    };
  }

  private serialized<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
