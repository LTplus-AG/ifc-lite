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
import type { ModelBackingOptions, ModelGeometryBacking } from './geometry-backing-registry';
import type { MeshData } from '@ifc-lite/geometry';

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
type SnapProbeCommand = Extract<GeometryBackingCommand, { action: 'snap-probe-for-test' }>;
type CameraCommand = Extract<GeometryBackingCommand, { action: 'camera-for-test' }>;
type InstancedBoundsCommand = Extract<GeometryBackingCommand, { action: 'instanced-bounds-for-test' }>;
type DeviceCommand = Extract<GeometryBackingCommand, { action: 'lose-device-for-test' | 'device-state-for-test' }>;
export interface DeviceState { lost: boolean; ready: boolean }
type BackingResult = ModelBackingStatus[] | SnapProbe[] | CameraPose[] | InstancedOccurrenceBounds[] | DeviceState[];
/** The viewport's derived visibility (store hides plus type-hidden ids, #10867): what its own picks run under. */
type ProbeVisibility = () => { hiddenIds?: ReadonlySet<number>; isolatedIds?: ReadonlySet<number> | null };
// Each command's own result type: a backing command never reads as a probe, nor the reverse.
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: SnapProbeCommand,
  visibility?: ProbeVisibility): Promise<SnapProbe[]>;
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: CameraCommand):
  Promise<CameraPose[]>;
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: InstancedBoundsCommand):
  Promise<InstancedOccurrenceBounds[]>;
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: DeviceCommand):
  Promise<DeviceState[]>;
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined,
  command: Exclude<GeometryBackingCommand, SnapProbeCommand | CameraCommand | InstancedBoundsCommand | DeviceCommand>): Promise<ModelBackingStatus[]>;
export function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: GeometryBackingCommand,
  visibility?: ProbeVisibility): Promise<BackingResult>;
export async function geometryBackingCommand(store: StoreApi<ReleaseState>, renderer: Renderer | undefined, command: GeometryBackingCommand,
  visibility?: ProbeVisibility): Promise<BackingResult> {
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
    return snapProbe(renderer, command.points, visibility?.() ?? {});
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

/** The hook's store: the tap's models plus the other CPU geometry sources a scene release would strand. */
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
 * TEST ONLY. Frees nothing unless the allowlist holds: every model's current generation verifies
 * (`acknowledge` + `verify`, never a void callback) against exactly its list, and no other geometry
 * source exists. Then releases the verified arrays and the scene together (neither alone frees a
 * shared buffer) and checks the scene really released: its guards refuse silently.
 */
async function releaseForTest(tap: StoreGeometryBackingTap, store: StoreApi<ReleaseState>, renderer: Renderer):
  Promise<ModelBackingStatus[]> {
  await tap.seal();
  const verified: Verified = new Map();
  for (const modelId of store.getState().models.keys()) {
    const candidate = tap.releaseCandidate(modelId);
    if (!candidate || !tap.registryHandle.verify(await candidate.backing.acknowledge())) {
      throw new Error(`Model ${modelId} has no verified complete backing; nothing was released`);
    }
    verified.set(modelId, candidate);
  }
  // The store may have changed during those awaits: no await between this check and the release.
  const lists = allowlisted(tap, store.getState(), verified);
  // `SceneContents` deliberately does not publish release; whether it should
  // is the product integration's API decision. Feature-detect for the test.
  const scene: object = renderer.getScene();
  if (!('releaseGeometryData' in scene) || typeof scene.releaseGeometryData !== 'function'
    || !('isGeometryDataReleased' in scene) || typeof scene.isGeometryDataReleased !== 'function') {
    throw new Error('This renderer exposes no scene release; nothing was released');
  }
  scene.releaseGeometryData();
  if (scene.isGeometryDataReleased() !== true) throw new Error('The scene refused to release; store geometry was kept');
  for (const meshes of lists) releaseCpuMeshBuffers(meshes);
  // A device loss from here on rebuilds from the backing (no CPU restore); without this it is refused.
  const { rebuildReleasedScene } = await import('./released-device-recovery');
  renderer.setReleasedSceneRebuild?.(rebuildReleasedScene);
  rebuildOn = renderer;
  return tap.status();
}

/**
 * The hover path's own sequence: readback (only when released), then the magnetic raycast, which, as on the
 * hover path, runs only on an answered read. A refused one (`unavailable`: an instanced or unbacked front
 * surface) reports no hit and no snap rather than whatever lies behind it, a point cloud included.
 */
async function snapProbe(renderer: Renderer, points: Array<[number, number]>,
  { hiddenIds, isolatedIds }: ReturnType<ProbeVisibility>): Promise<SnapProbe[]> {
  const { feedReadbackAt, readbackFeeder } = await import('./readback-measure');
  const { sceneGeometryReleased } = await import('./scene-released');
  const out: SnapProbe[] = [];
  for (const [x, y] of points) {
    // Under the viewport's own visibility: type-hidden meshes are uploaded and hidden only by id (#10867).
    const outcome = sceneGeometryReleased(renderer) ? await feedReadbackAt(renderer, x, y, { hiddenIds, isolatedIds }) : 'resident';
    if (outcome !== 'fed' && outcome !== 'no-hit' && outcome !== 'resident') {
      const error = outcome === 'unavailable' ? readbackFeeder(renderer).lastError?.message : undefined;
      out.push({ outcome, ...(error ? { error } : {}), expressId: null, instanced: false, point: null, snap: null });
      continue;
    }
    const result = renderer.raycastSceneMagnetic(x, y, { edge: null, meshExpressId: null, lockStrength: 0 },
      // The raycast only reads these sets; the viewport hands them over read-only.
      { hiddenIds: hiddenIds as Set<number> | undefined, isolatedIds: isolatedIds as Set<number> | null | undefined,
        snapOptions: { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 40 } });
    const hit = result.intersection;
    const target = result.snapTarget;
    out.push({ outcome, expressId: hit?.expressId ?? null, instanced: hit ? renderer.getScene().isInstancedEntity(hit.expressId) : false,
      point: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
      snap: target ? { type: String(target.type), position: [target.position.x, target.position.y, target.position.z] } : null });
  }
  return out;
}
