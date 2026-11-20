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
  | { action: 'release-for-test' }
  /** TEST ONLY: magnetic snap at canvas CSS points, through readback when released. */
  | { action: 'snap-probe-for-test'; points: Array<[number, number]> };

export interface SnapProbe {
  outcome: string;
  expressId: number | null;
  point: [number, number, number] | null;
  snap: { type: string; position: [number, number, number] } | null;
}

let starting: Promise<StoreGeometryBackingTap> | undefined;
let active: StoreGeometryBackingTap | undefined;

/** The running tap, if a test or debug session started one. */
export function activeGeometryBackingTap(): StoreGeometryBackingTap | undefined { return active; }

/** `renderer` is needed only by `release-for-test`; a test may start the tap
 * before the viewport has one, so the whole stream is observed. */
export async function geometryBackingCommand(store: StoreApi<TapState>, renderer: Renderer | undefined, command: GeometryBackingCommand):
  Promise<ModelBackingStatus[] | SnapProbe[]> {
  if (command.action === 'snap-probe-for-test') {
    if (!renderer) throw new Error('Snap probes need the viewport renderer');
    return snapProbe(renderer, command.points);
  }
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
  for (const modelId of new Set([...models.keys(), ...verified.keys()])) {
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

/** The hover path's own sequence: readback (only when released), then the magnetic raycast. */
async function snapProbe(renderer: Renderer, points: Array<[number, number]>): Promise<SnapProbe[]> {
  const { feedReadbackAt } = await import('./readback-measure');
  const { sceneGeometryReleased } = await import('./scene-released');
  const out: SnapProbe[] = [];
  for (const [x, y] of points) {
    const outcome = sceneGeometryReleased(renderer) ? await feedReadbackAt(renderer, x, y, {}) : 'resident';
    const result = renderer.raycastSceneMagnetic(x, y, { edge: null, meshExpressId: null, lockStrength: 0 },
      { snapOptions: { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 40 } });
    const hit = result.intersection;
    const target = result.snapTarget;
    out.push({ outcome, expressId: hit?.expressId ?? null,
      point: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
      snap: target ? { type: String(target.type), position: [target.position.x, target.position.y, target.position.z] } : null });
  }
  return out;
}
