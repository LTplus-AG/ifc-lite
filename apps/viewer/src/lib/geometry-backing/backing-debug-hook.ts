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
  | { action: 'snap-probe-for-test'; points: Array<[number, number]> }
  /** TEST ONLY: read the camera pose, or pin it first, so screen probes compare like for like. */
  | { action: 'camera-for-test'; pose?: CameraPose }
  /** TEST ONLY: the scene's own instanced occurrence bounds (placed frame), independent of any backing. */
  | { action: 'instanced-bounds-for-test' }
  /** TEST ONLY: destroy the live GPU device (a real loss), or read whether the renderer is lost / ready again. */
  | { action: 'lose-device-for-test' | 'device-state-for-test' };

type Xyz = { x: number; y: number; z: number };
export interface CameraPose { position: Xyz; target: Xyz; up: Xyz }
/** TEST ONLY: one instanced entity's occurrence bounds as the scene holds them (placed frame). */
export interface InstancedOccurrenceBounds { id: number; bounds: ReturnType<ReturnType<Renderer['getScene']>['getInstancedEntityBounds']> }

export interface SnapProbe {
  outcome: string;
  error?: string;
  instanced: boolean;
  expressId: number | null;
  point: [number, number, number] | null;
  snap: { type: string; position: [number, number, number] } | null;
}

let starting: Promise<StoreGeometryBackingTap> | undefined;
let active: StoreGeometryBackingTap | undefined;
/** The renderer the test-only release registered a released-scene rebuild on. */
let rebuildOn: Renderer | undefined;

/** The running tap, if a test or debug session started one. */
export function activeGeometryBackingTap(): StoreGeometryBackingTap | undefined { return active; }

/** `renderer` is needed only by `release-for-test`; a test may start the tap
 * before the viewport has one, so the whole stream is observed. */
export async function geometryBackingCommand(store: StoreApi<TapState>, renderer: Renderer | undefined, command: GeometryBackingCommand):
  Promise<ModelBackingStatus[] | SnapProbe[] | CameraPose[] | InstancedOccurrenceBounds[] | Array<{ lost: boolean; ready: boolean }>> {
  if (command.action === 'lose-device-for-test' || command.action === 'device-state-for-test') {
    if (!renderer) throw new Error('Device actions need the viewport renderer');
    if (command.action === 'lose-device-for-test') renderer.getGPUDevice()?.destroy();
    return [{ lost: renderer.isDeviceLost(), ready: renderer.isReady() }];
  }
  if (command.action === 'camera-for-test') {
    const camera = renderer?.getCamera();
    if (!camera) throw new Error('Camera poses need the viewport renderer');
    const { pose } = command;
    if (pose) { camera.setPosition(pose.position.x, pose.position.y, pose.position.z); camera.setTarget(pose.target.x, pose.target.y, pose.target.z); camera.setUp(pose.up.x, pose.up.y, pose.up.z); }
    return [{ position: { ...camera.getPosition() }, target: { ...camera.getTarget() }, up: { ...camera.getUp() } }];
  }
  if (command.action === 'instanced-bounds-for-test') {
    if (!renderer) throw new Error('Instanced bounds need the viewport renderer');
    const scene = renderer.getScene();
    return [...scene.getInstancedEntityIds()].map((id) => ({ id, bounds: scene.getInstancedEntityBounds(id) }));
  }
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
  rebuildOn?.setReleasedSceneRebuild?.(null);
  rebuildOn = undefined;
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
  const models = store.getState().models;
  for (const modelId of models.keys()) {
    const backing = tap.backing(modelId);
    const row = status.find((entry) => entry.modelId === modelId);
    if (!backing || !row?.complete || !tap.registryHandle.verify(await backing.acknowledge())) {
      throw new Error(`Model ${modelId} has no verified complete backing; nothing was released`);
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
  // A device loss from here on rebuilds from the backing (no CPU restore); without this it is refused.
  const { rebuildReleasedScene } = await import('./released-device-recovery');
  renderer.setReleasedSceneRebuild?.(rebuildReleasedScene);
  rebuildOn = renderer;
  return tap.status();
}

/** The hover path's own sequence: readback (only when released), then the magnetic raycast. */
async function snapProbe(renderer: Renderer, points: Array<[number, number]>): Promise<SnapProbe[]> {
  const { feedReadbackAt, readbackFeeder } = await import('./readback-measure');
  const { sceneGeometryReleased } = await import('./scene-released');
  const out: SnapProbe[] = [];
  for (const [x, y] of points) {
    const outcome = sceneGeometryReleased(renderer) ? await feedReadbackAt(renderer, x, y, {}) : 'resident';
    const result = renderer.raycastSceneMagnetic(x, y, { edge: null, meshExpressId: null, lockStrength: 0 },
      { snapOptions: { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 40 } });
    const hit = result.intersection;
    const target = result.snapTarget;
    const error = outcome === 'unavailable' ? readbackFeeder(renderer).lastError?.message : undefined;
    out.push({ outcome, ...(error ? { error } : {}), expressId: hit?.expressId ?? null, instanced: hit ? renderer.getScene().isInstancedEntity(hit.expressId) : false,
      point: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
      snap: target ? { type: String(target.type), position: [target.position.x, target.position.y, target.position.z] } : null });
  }
  return out;
}
