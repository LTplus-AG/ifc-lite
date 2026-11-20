/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `__ifc_lite_geometry_backing__` (test/debug only, #10264): start, inspect,
 * seal and stop the store backing tap. Nothing calls it in product use, and
 * nothing here releases CPU geometry. Readback consumers find the running tap
 * through `activeGeometryBackingTap()`.
 */

import type { StoreApi } from 'zustand';
import type { Renderer } from '@ifc-lite/renderer';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { StoreGeometryBackingTap, type ModelBackingStatus, type TapState } from './store-backing-tap';
import type { ModelBackingOptions } from './geometry-backing-registry';

export type GeometryBackingCommand =
  | { action: 'start'; options?: ModelBackingOptions }
  | { action: 'status' | 'seal' | 'stop' }
  /** TEST ONLY: release CPU geometry of every model after verifying its backing. */
  | { action: 'release-for-test' };

let starting: Promise<StoreGeometryBackingTap> | undefined;
let active: StoreGeometryBackingTap | undefined;

/** The running tap, if a test or debug session started one. */
export function activeGeometryBackingTap(): StoreGeometryBackingTap | undefined { return active; }

/** `renderer` is needed only by `release-for-test`; a test may start the tap
 * before the viewport has one, so the whole stream is observed. */
export async function geometryBackingCommand(store: StoreApi<TapState>, renderer: Renderer | undefined, command: GeometryBackingCommand):
  Promise<ModelBackingStatus[]> {
  if (command.action === 'start') {
    if (!starting) {
      const pending = StoreGeometryBackingTap.start(store, command.options);
      starting = pending;
      pending.then((tap) => { if (starting === pending) active = tap; }, () => { if (starting === pending) starting = undefined; });
    }
    return (await starting).status();
  }
  const tap = active ?? (starting ? await starting : undefined);
  if (!tap) throw new Error('Geometry backing is not started');
  if (command.action === 'status') return tap.status();
  if (command.action === 'seal') return tap.seal();
  if (command.action === 'release-for-test') {
    if (!renderer) throw new Error('Test-only release needs the viewport renderer; nothing was released');
    return releaseForTest(tap, store, renderer);
  }
  const final = tap.status();
  active = undefined;
  starting = undefined;
  await tap.stop();
  return final;
}

/**
 * TEST ONLY. Frees nothing unless EVERY model's current generation verifies
 * (`acknowledge` + `verify`, never a void callback), then releases the store
 * arrays and the scene together (neither alone frees a shared buffer) and
 * checks the scene really released: its guards refuse silently.
 */
async function releaseForTest(tap: StoreGeometryBackingTap, store: StoreApi<TapState>, renderer: Renderer):
  Promise<ModelBackingStatus[]> {
  const status = await tap.seal();
  const verified = new Map<string, NonNullable<ReturnType<typeof tap.backing>>>();
  for (const modelId of store.getState().models.keys()) {
    const backing = tap.backing(modelId);
    const row = status.find((entry) => entry.modelId === modelId);
    if (!backing || !row?.complete || !tap.registryHandle.verify(await backing.acknowledge())) {
      throw new Error(`Model ${modelId} has no verified complete backing; nothing was released`);
    }
    verified.set(modelId, backing);
  }
  // The store may have changed during those awaits: re-check synchronously, with no await between this and
  // the release, that exactly the verified models and generations are current and still complete.
  const models = store.getState().models;
  const now = new Map(tap.status().map((row) => [row.modelId, row]));
  // Every model the tap tracks too: one whose shards arrived before it was registered is not in the store's
  // model set, so the loop above never verified it; it blocks the release (fail closed).
  for (const modelId of new Set([...models.keys(), ...verified.keys(), ...now.keys()])) {
    const backing = verified.get(modelId);
    if (!backing || !models.has(modelId) || tap.backing(modelId) !== backing || !now.get(modelId)?.complete
      || now.get(modelId)?.generation !== backing.generation) {
      throw new Error(`Model ${modelId} changed while its backing was verified; nothing was released`);
    }
  }
  // `SceneContents` deliberately does not publish release; whether it should
  // is the product integration's API decision. Feature-detect for the test.
  const scene: object = renderer.getScene();
  if (!('releaseGeometryData' in scene) || typeof scene.releaseGeometryData !== 'function'
    || !('isGeometryDataReleased' in scene) || typeof scene.isGeometryDataReleased !== 'function') {
    throw new Error('This renderer exposes no scene release; nothing was released');
  }
  scene.releaseGeometryData();
  if (scene.isGeometryDataReleased() !== true) throw new Error('The scene refused to release; store geometry was kept');
  for (const model of models.values()) if (model.geometryResult) releaseCpuMeshBuffers(model.geometryResult.meshes);
  return tap.status();
}
