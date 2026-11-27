/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The page's one live-geometry backing tap (#10264) and the verified release of
 * CPU geometry against it.
 *
 * Two callers start a tap: GPU-only residency (`gpu-only-residency.ts`, behind
 * `?perf.gpuOnly`) and the test/debug hook (`backing-debug-hook.ts`). Readback
 * consumers find the running one through `activeGeometryBackingTap()`.
 *
 * `releaseVerifiedGeometry` is the only place CPU geometry is released against
 * a backing. It frees nothing unless every geometry source in the store is a
 * list whose current backing generation verifies.
 */

import type { StoreApi } from 'zustand';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import type { ModelBackingOptions, ModelGeometryBacking } from './geometry-backing-registry';
import type { BackingDatabaseOptions } from './backing-database';
import { StoreGeometryBackingTap, type ModelBackingStatus, type TapState } from './store-backing-tap';

let starting: Promise<StoreGeometryBackingTap> | undefined;
let active: StoreGeometryBackingTap | undefined;
/** The renderer a release registered a released-scene rebuild on. */
let rebuildOn: Renderer | undefined;

/** The running tap, if one was started. */
export function activeGeometryBackingTap(): StoreGeometryBackingTap | undefined { return active; }

/** A tap is running or starting: whoever starts one now joins it and does not own it. */
export function geometryBackingInUse(): boolean { return active !== undefined || starting !== undefined; }

/** Start the tap, or join the start already under way: a page has one. */
export function startGeometryBacking(store: StoreApi<ReleaseState>,
  options?: ModelBackingOptions & { database?: BackingDatabaseOptions }): Promise<StoreGeometryBackingTap> {
  if (!starting) {
    const pending = StoreGeometryBackingTap.start(store, options);
    starting = pending;
    pending.then((tap) => { if (starting === pending) active = tap; }, () => { if (starting === pending) starting = undefined; });
  }
  return starting;
}

/** The running tap, waiting for a start under way; undefined when none was started. */
export async function runningGeometryBacking(): Promise<StoreGeometryBackingTap | undefined> {
  return active ?? (starting ? await starting : undefined);
}

/** Stop `tap` and forget it. Returns its last status. A tap that is no longer the page's is left alone. */
export async function stopGeometryBacking(tap: StoreGeometryBackingTap): Promise<ModelBackingStatus[]> {
  const final = tap.status();
  if (active !== tap) return final;
  rebuildOn?.setReleasedSceneRebuild?.(null);
  rebuildOn = undefined;
  active = undefined;
  starting = undefined;
  await tap.stop();
  return final;
}

/** The store a release reads: the tap's models plus the other CPU geometry sources a scene release would strand. */
export interface ReleaseState extends TapState {
  /** The single-model top-level result; it may be the same object as a model's. */
  geometryResult?: { meshes: MeshData[] } | null;
  /** The delete-undo stash. */
  removedMeshes?: ReadonlyMap<unknown, { meshes?: readonly MeshData[] }>;
}

type Verified = Map<string, { backing: ModelGeometryBacking; meshes: MeshData[] }>;

/**
 * The positive allowlist (#10876), checked synchronously right before the release: every geometry source
 * in the state is a verified list, and every verified list is still its model's current candidate. An empty
 * set never passes. Returns the lists to release, or throws and nothing is released.
 */
function allowlisted(tap: StoreGeometryBackingTap, state: ReleaseState, verified: Verified): MeshData[][] {
  if (verified.size === 0 || state.models.size === 0) throw new Error('No verified model geometry; nothing was released');
  const lists = new Set<MeshData[]>();
  for (const [modelId, model] of state.models) {
    const entry = verified.get(modelId), candidate = tap.releaseCandidate(modelId);
    if (!entry || !candidate || candidate.backing !== entry.backing || candidate.meshes !== entry.meshes
      || model.geometryResult?.meshes !== entry.meshes) {
      throw new Error(`Model ${modelId} has no verified current backing of its geometry; nothing was released`);
    }
    lists.add(entry.meshes);
  }
  // Every model the tap tracks and every verified one is a registered, verified model (fail closed).
  for (const modelId of new Set([...verified.keys(), ...tap.status().map((row) => row.modelId)])) {
    if (!state.models.has(modelId)) throw new Error(`Model ${modelId} is not a registered model; nothing was released`);
  }
  if (state.geometryResult && !lists.has(state.geometryResult.meshes)) {
    throw new Error('The top-level geometry is not a verified model\'s list; nothing was released');
  }
  for (const stash of state.removedMeshes?.values() ?? []) {
    if (stash.meshes && stash.meshes.length > 0) throw new Error('Removed-mesh undo geometry is not backed; nothing was released');
  }
  return [...lists];
}

/**
 * Release the store's CPU geometry and the scene's against `tap`.
 *
 * Frees nothing unless the allowlist holds: every model's current generation verifies
 * (`acknowledge` + `verify`, never a void callback) against exactly its list, and no other geometry
 * source exists. Then releases the verified arrays and the scene together (neither alone frees a
 * shared buffer) and checks the scene really released: its guards refuse silently.
 *
 * @throws when anything is unverified or the scene refuses; nothing was released then.
 */
export async function releaseVerifiedGeometry(tap: StoreGeometryBackingTap, store: StoreApi<ReleaseState>, renderer: Renderer):
  Promise<ModelBackingStatus[]> {
  const models = store.getState().models;
  await tap.seal();
  // Fetched before anything is freed: once the arrays are gone, nothing below may fail or wait.
  const { rebuildReleasedScene } = await import('./released-device-recovery');
  const verified: Verified = new Map();
  for (const [modelId, model] of models) {
    const candidate = tap.releaseCandidate(modelId);
    if (!candidate || candidate.meshes !== model.geometryResult?.meshes
      || !tap.registryHandle.verify(await candidate.backing.acknowledge())) {
      throw new Error(`Model ${modelId} has no verified complete backing; nothing was released`);
    }
    verified.set(modelId, candidate);
  }
  // The store may have changed during those awaits: no await between this check and the release.
  const lists = allowlisted(tap, store.getState(), verified);
  // `SceneContents` deliberately does not publish release: feature-detect it.
  const scene: object = renderer.getScene();
  if (!('releaseGeometryData' in scene) || typeof scene.releaseGeometryData !== 'function'
    || !('isGeometryDataReleased' in scene) || typeof scene.isGeometryDataReleased !== 'function') {
    throw new Error('This renderer exposes no scene release; nothing was released');
  }
  scene.releaseGeometryData();
  if (scene.isGeometryDataReleased() !== true) throw new Error('The scene refused to release; store geometry was kept');
  for (const meshes of lists) releaseCpuMeshBuffers(meshes);
  // A device loss from here on rebuilds from the backing (no CPU restore); without this it is refused.
  renderer.setReleasedSceneRebuild?.(rebuildReleasedScene);
  rebuildOn = renderer;
  return tap.status();
}
