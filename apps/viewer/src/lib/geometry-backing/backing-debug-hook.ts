/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `__ifc_lite_geometry_backing__` (test/debug only, #10264): start, inspect,
 * seal and stop the store backing tap, and the test-only probes. The running
 * tap and the verified release live in `active-backing.ts`, which product code
 * uses too; this file is the command surface a test drives them through.
 */

import type { StoreApi } from 'zustand';
import type { Renderer } from '@ifc-lite/renderer';
import type { ModelBackingStatus } from './store-backing-tap';
import type { ModelBackingOptions } from './geometry-backing-registry';
import { releaseVerifiedGeometry, runningGeometryBacking, startGeometryBacking, stopGeometryBacking, type ReleaseState } from './active-backing';

export { activeGeometryBackingTap, type ReleaseState } from './active-backing';

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
  if (command.action === 'start') return (await startGeometryBacking(store, command.options)).status();
  const tap = await runningGeometryBacking();
  if (!tap) throw new Error('Geometry backing is not started');
  if (command.action === 'status') return tap.status();
  if (command.action === 'seal') return tap.seal();
  if (command.action === 'release-for-test') {
    if (!renderer) throw new Error('Test-only release needs the viewport renderer; nothing was released');
    return releaseVerifiedGeometry(tap, store, renderer);
  }
  return stopGeometryBacking(tap);
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
