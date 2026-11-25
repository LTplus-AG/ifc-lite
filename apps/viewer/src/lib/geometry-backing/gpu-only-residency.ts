/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-only geometry residency, behind `?perf.gpuOnly=on|auto` (off by default; `auto` arms it for
 * sources of at least `GPU_ONLY_AUTO_BYTES`).
 *
 * An armed primary load is mirrored into the live-geometry backing (`store-backing-tap.ts`) while it
 * streams. Once the load has completed and the scene has settled, the backing is sealed and verified
 * and the CPU geometry of the store and the scene is released against it
 * (`releaseVerifiedGeometry`): the triangles then live on the GPU and in the backing only, and
 * consumers read them back on demand (`geometry-readback.ts` and friends).
 *
 * The stream itself is the ordinary one, so nothing is given up before the backing has verified:
 * a load whose backing fails, or that is joined by a second model before its release, keeps its CPU
 * geometry exactly as with the switch off.
 */

import type { StoreApi } from 'zustand';
import type { Renderer } from '@ifc-lite/renderer';
import { getGlobalRenderer } from '@/lib/renderer-ref';
import { afterSceneSettled } from '@/lib/scene-settled';
import { useViewerStore } from '@/store';
import { geometryBackingInUse, releaseVerifiedGeometry, startGeometryBacking, stopGeometryBacking, type ReleaseState } from './active-backing';
import { gpuOnlyRequested } from './gpu-only-mode';
import type { StoreGeometryBackingTap } from './store-backing-tap';

export interface GpuOnlyStatus {
  modelId: string | null;
  phase: 'idle' | 'streaming' | 'releasing' | 'released' | 'failed' | 'cancelled';
  /** Why a load that was armed kept its CPU geometry. */
  error?: string;
  /** ms from arming to the verified release. */
  releaseMs?: number;
}

/** The store fields the controller reads and writes. */
export interface GpuOnlyState extends ReleaseState {
  models: ReadonlyMap<string, {
    geometryResult: { meshes: import('@ifc-lite/geometry').MeshData[] } | null;
    idOffset?: number;
    fileSize?: number;
    loadState?: string;
  }>;
  setBoundedGeometryMode(bounded: boolean): void;
}

/** What the controller calls out to; replaced by fakes in its tests. */
export interface GpuOnlyDeps {
  requested(sourceBytes: number): boolean;
  /** A tap is already running or starting (a debug session's): the controller joins it and never stops it. */
  tapInUse(): boolean;
  /** Start the page's tap, or join the one that exists. */
  startTap(store: StoreApi<ReleaseState>): Promise<StoreGeometryBackingTap>;
  stopTap(tap: StoreGeometryBackingTap): Promise<unknown>;
  release(tap: StoreGeometryBackingTap, store: StoreApi<ReleaseState>, renderer: Renderer): Promise<unknown>;
  renderer(): Renderer | null;
  /** Calls `done(true)` once the scene has settled and drawn, `done(false)` when `isCurrent` turns false or it times out. */
  whenSettled(done: (settled: boolean) => void, isCurrent: () => boolean): () => void;
  now(): number;
}

const PRODUCT_DEPS: GpuOnlyDeps = {
  requested: gpuOnlyRequested,
  tapInUse: geometryBackingInUse,
  startTap: (store) => startGeometryBacking(store),
  stopTap: stopGeometryBacking,
  release: releaseVerifiedGeometry,
  renderer: getGlobalRenderer,
  whenSettled: afterSceneSettled,
  now: () => performance.now(),
};

interface Armed {
  modelId: string;
  begun: number;
  tap: Promise<StoreGeometryBackingTap>;
  cancelSettle: (() => void) | null;
  /** The release has begun. From here the load is no longer cancelled: its arrays may already be gone. */
  releasing: boolean;
}

export class GpuOnlyResidency {
  private armed: Armed | null = null;
  /** The last model armed: a load gets one attempt, so a failed or cancelled one is not armed again. */
  private lastArmed: string | null = null;
  private last: GpuOnlyStatus = { modelId: null, phase: 'idle' };
  /**
   * The tap this controller started, while it may still stop it: from its start until a release
   * succeeds against it (the backing is then the only copy and is never stopped from here). One per
   * controller, not per load, so a quick reload reuses a start that is still under way.
   */
  private ownStart: Promise<StoreGeometryBackingTap> | null = null;
  /** A load that needed `ownStart` was disarmed while no other load needs it. */
  private stopOwnWhenIdle = false;

  constructor(private readonly store: StoreApi<GpuOnlyState>, private readonly deps: GpuOnlyDeps = PRODUCT_DEPS) {}

  status(): GpuOnlyStatus { return { ...this.last }; }

  /** Follow the store until the returned uninstall is called. */
  install(): () => void {
    const unsubscribe = this.store.subscribe((state) => this.onState(state));
    this.onState(this.store.getState());
    return () => { unsubscribe(); this.cancel('uninstalled'); };
  }

  private onState(state: GpuOnlyState): void {
    const armed = this.armed;
    if (armed) {
      if (armed.releasing) return;
      const model = state.models.get(armed.modelId);
      if (model) {
        // A second model joined before the release: its geometry is no part of what this load backs
        // from the start, so this load keeps its geometry.
        if (state.models.size > 1) return this.cancel('a second model joined before the release');
        if (model.loadState === 'error') return this.cancel('the load failed');
        if (model.loadState === 'complete' && !armed.cancelSettle) this.releaseWhenSettled(armed);
        return;
      }
      // A superseding load removed the model; that load may be armed in its turn, below.
      this.cancel('superseded');
    }
    // A model that left the store may come back under the same id (a reload): it is a new load.
    if (this.lastArmed !== null && !state.models.has(this.lastArmed)) this.lastArmed = null;
    if (state.models.size !== 1) return;
    const [[modelId, model]] = state.models;
    // The placeholder a primary load registers before any of its geometry reaches the store.
    if (modelId === this.lastArmed || model.loadState !== 'pending' || model.geometryResult || !this.deps.requested(model.fileSize ?? 0)) return;
    this.arm(modelId);
  }

  private arm(modelId: string): void {
    const armed: Armed = { modelId, begun: this.deps.now(), tap: this.tapFor(), cancelSettle: null, releasing: false };
    this.armed = armed;
    this.lastArmed = modelId;
    this.last = { modelId, phase: 'streaming' };
    // The loader skips the mesh cache write of a primary load whose arrays will be released under it.
    this.store.getState().setBoundedGeometryMode(true);
    armed.tap.catch((error: unknown) => { if (this.armed === armed) this.fail(armed, error); });
  }

  /** This controller's own tap (started now, or still starting from an earlier load), or the one a debug session runs. */
  private tapFor(): Promise<StoreGeometryBackingTap> {
    this.stopOwnWhenIdle = false;
    if (this.ownStart) return this.ownStart;
    if (this.deps.tapInUse()) return this.deps.startTap(this.store);
    const start = this.deps.startTap(this.store);
    this.ownStart = start;
    start.then(() => { if (this.ownStart === start && this.stopOwnWhenIdle) this.stopOwn(); },
      () => { if (this.ownStart === start) this.ownStart = null; });
    return start;
  }

  /** Stop the tap this controller started, once no armed load needs it. */
  private stopOwn(): void {
    const start = this.ownStart;
    if (!start) return;
    this.stopOwnWhenIdle = true;
    void start.then((tap) => {
      if (this.ownStart !== start || !this.stopOwnWhenIdle) return; // a later load took it over
      this.ownStart = null;
      this.stopOwnWhenIdle = false;
      void this.deps.stopTap(tap);
    }, () => undefined);
  }

  private releaseWhenSettled(armed: Armed): void {
    armed.cancelSettle = this.deps.whenSettled((settled) => {
      if (this.armed !== armed) return;
      if (!settled) return this.fail(armed, new Error('the scene did not settle'));
      void this.release(armed);
    }, () => this.armed === armed);
  }

  private async release(armed: Armed): Promise<void> {
    this.last = { modelId: armed.modelId, phase: 'releasing' };
    try {
      const renderer = this.deps.renderer();
      if (!renderer) throw new Error('no viewport renderer');
      const tap = await armed.tap;
      if (this.armed !== armed) return;
      // Not cancellable from here: a store change during the release must not stop the tap under it.
      armed.releasing = true;
      await this.deps.release(tap, this.store, renderer);
    } catch (error) {
      // The release throws before it frees anything, so the load still has its CPU geometry.
      armed.releasing = false;
      if (this.armed === armed) this.fail(armed, error);
      return;
    }
    // Released: the backing is the only copy now, so its tap is never stopped from here.
    if (this.ownStart === armed.tap) this.ownStart = null;
    this.armed = null;
    this.last = { modelId: armed.modelId, phase: 'released', releaseMs: this.deps.now() - armed.begun };
    this.store.getState().setBoundedGeometryMode(false);
    console.info(`[GpuOnly] CPU geometry released ${Math.round(this.last.releaseMs ?? 0)} ms after the load began`);
  }

  /** Nothing was released: the load keeps its CPU geometry, as with the switch off. */
  private fail(armed: Armed, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[GpuOnly] CPU geometry stays resident:', error);
    this.disarm(armed, { modelId: armed.modelId, phase: 'failed', error: message });
  }

  private cancel(reason: string): void {
    const armed = this.armed;
    if (armed && !armed.releasing) this.disarm(armed, { modelId: armed.modelId, phase: 'cancelled', error: reason });
  }

  private disarm(armed: Armed, status: GpuOnlyStatus): void {
    armed.cancelSettle?.();
    this.armed = null;
    this.last = status;
    this.stopOwn();
    this.store.getState().setBoundedGeometryMode(false);
  }
}

/** Install the controller on the viewer store; the status is readable through `__ifc_lite_gpu_only_status__`. */
export function installGpuOnlyController(): () => void {
  const controller = new GpuOnlyResidency(useViewerStore);
  const host = globalThis as { __ifc_lite_gpu_only_status__?: () => GpuOnlyStatus };
  host.__ifc_lite_gpu_only_status__ = () => controller.status();
  const uninstall = controller.install();
  return () => { uninstall(); delete host.__ifc_lite_gpu_only_status__; };
}
