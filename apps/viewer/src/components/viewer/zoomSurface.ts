/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The surface a zoom-in approaches (#5393, #5547, #5924), shared by every zoom
 * entry point: the wheel (`wheelZoom.ts`, which trackpad pinch also arrives
 * as), touch pinch (`useTouchControls.ts`), and the cursorless toolbar zoom-in
 * and SpaceMouse dolly ({@link createCentreSurfaceZoom}). Each picks a point
 * here and hands it to `Camera.zoom(..., surfacePoint)`, which stops short of
 * it instead of passing through thin objects.
 */

import { isPivotRaycastTooExpensive, type PivotCensusScene } from './orbitPivotCensus.js';
import { surfaceProbeFor, type SurfaceProbeCamera, type SurfaceProbeRenderer } from './surfaceProbe.js';

/** World-space point on the visible surface under the cursor or pinch. */
export interface SurfacePoint { x: number; y: number; z: number }

/** A canvas point (CSS px) to the surface under it, or null for empty space. */
export interface ZoomSurfacePicker {
  (x: number, y: number): SurfacePoint | null;
  /**
   * True when the pick answers from the depth probe (#8769): cheap, and it
   * sharpens as the camera nears, so callers re-pick on every step instead of
   * once per gesture. Absent or false: the CPU raycast, picked once.
   */
  live?(): boolean;
  /**
   * When {@link live}, the surface under the point once the probe this pick
   * requested lands (a frame later): for a press that found none yet.
   */
  probed?(x: number, y: number): Promise<SurfacePoint | null>;
  /** Probe ahead where the raycast is gated (the hover), so the next gesture finds an answer. */
  prime?(x: number, y: number): void;
}

/** What {@link createZoomSurfacePicker} needs from the renderer. */
export interface ZoomSurfaceRenderer extends SurfaceProbeRenderer {
  getScene(): PivotCensusScene;
  raycastScene(x: number, y: number, options: ZoomSurfacePickOptions): { intersection: { point: SurfacePoint } } | null;
}
export interface ZoomSurfacePickOptions { isStreaming: boolean; hiddenIds: Set<number>; isolatedIds: Set<number> | null }

/**
 * Whether the CPU raycast is off limits for a surface pick: the first call
 * builds a BVH over every entity, which stalls large models for seconds
 * (orbitPivotCensus.ts), and while streaming the mesh set changes under it.
 * A model with a robust orbit anchor (#1394) skips it too: its sparse far
 * tail makes the raycast both slow and unneeded.
 */
export function isSurfaceRaycastGated(
  renderer: Pick<ZoomSurfaceRenderer, 'getScene'>,
  camera: { getOrbitAnchorBounds(): unknown },
  isStreaming: boolean,
): boolean {
  return isStreaming || camera.getOrbitAnchorBounds() !== null || isPivotRaycastTooExpensive(renderer.getScene());
}

/** Identity of a visibility state: a new or resized hidden/isolated set is a new key. */
const setIds = new WeakMap<object, number>();
let nextSetId = 0;
function visibilityKey(options: Pick<ZoomSurfacePickOptions, 'hiddenIds' | 'isolatedIds'>): string {
  const id = (s: Set<number>) => {
    let n = setIds.get(s);
    if (n === undefined) setIds.set(s, (n = ++nextSetId));
    return `${n}:${s.size}`;
  };
  return `${id(options.hiddenIds)}|${options.isolatedIds ? id(options.isolatedIds) : '-'}`;
}

/**
 * The viewer's surface pick, shared by zoom and the orbit pivot: the CPU
 * raycast where {@link isSurfaceRaycastGated} allows it, else the last frame's
 * depth under the point (`surfaceProbe.ts`, #8769), else null (plain zoom,
 * scene-centre pivot). Every gated pick also asks for a fresh probe there.
 */
export function createZoomSurfacePicker(
  renderer: ZoomSurfaceRenderer,
  camera: { getOrbitAnchorBounds(): unknown } & SurfaceProbeCamera,
  getPickOptions: () => ZoomSurfacePickOptions,
): ZoomSurfacePicker {
  const probe = surfaceProbeFor(renderer, camera);
  let gated = false;
  const pick: ZoomSurfacePicker = (x, y) => {
    const options = getPickOptions();
    gated = isSurfaceRaycastGated(renderer, camera, options.isStreaming);
    if (!gated) return renderer.raycastScene(x, y, options)?.intersection.point ?? null;
    if (!probe) return null;
    const scene = visibilityKey(options);
    const point = probe.peek(x, y, scene);
    void probe.request(x, y, scene);
    return point;
  };
  pick.live = () => gated && probe !== null;
  pick.prime = (x, y) => {
    const options = getPickOptions();
    if (probe && isSurfaceRaycastGated(renderer, camera, options.isStreaming)) void probe.request(x, y, visibilityKey(options));
  };
  pick.probed = (x, y) => {
    if (!pick.live?.() || !probe) return Promise.resolve(null);
    const scene = visibilityKey(getPickOptions());
    return probe.request(x, y, scene).then(() => probe.peek(x, y, scene));
  };
  return pick;
}

/** Both ends of the view ray: a look-around keeps the position but turns it. */
export interface ZoomPoseCamera {
  getPosition(): SurfacePoint;
  getTarget(): SurfacePoint;
}

/**
 * The camera pose as a comparable key. A picked point stays on the cursor ray
 * only while the surface zoom is the sole thing moving the camera (it
 * translates along that ray), so callers record the pose after each surface
 * step and re-pick when anything else (a plain or fast zoom, an orbit, a pan,
 * a look-around) left a different one.
 */
export function cameraPoseKey(c: ZoomPoseCamera): string {
  const p = c.getPosition(), t = c.getTarget();
  return `${p.x},${p.y},${p.z}|${t.x},${t.y},${t.z}`;
}

/**
 * How stale a cached surface pick may get. Past it the scene may have changed
 * under the camera (an element hidden, isolated or streamed in), so the next
 * zoom-in picks afresh. The wheel measures it from its last notch (a pause
 * ends the gesture); the cursorless zoom from the pick itself, so a held
 * SpaceMouse re-picks at this rate rather than never.
 */
export const SURFACE_PICK_IDLE_MS = 400;

/** The part of `Camera` a surface zoom drives. */
export interface SurfaceZoomCamera extends ZoomPoseCamera {
  zoom(
    delta: number,
    addVelocity?: boolean,
    mouseX?: number,
    mouseY?: number,
    canvasWidth?: number,
    canvasHeight?: number,
    fastZoom?: boolean,
    surfacePoint?: SurfacePoint,
  ): void;
}

/**
 * Zoom with no cursor to anchor it (#5924): the toolbar zoom-in and the
 * SpaceMouse dolly. Both zoom along the view axis, so the surface they
 * approach is the one at the centre of `canvas` (CSS px). Zoom-in picks it
 * through the gated {@link createZoomSurfacePicker} and stops short of it;
 * zoom-out and a miss keep the plain zoom, unchanged.
 *
 * The surface step translates the camera along the centre ray, so a pick stays
 * valid while only this zoom moves the camera: it is reused while the pose is
 * the one the last step left and the pick is under
 * {@link SURFACE_PICK_IDLE_MS} old. A SpaceMouse held forward therefore
 * raycasts a few times a second, not once per frame, and a hold that began
 * with no pick (streaming, a miss) picks again while still held; an orbit,
 * pan or other zoom in between forces a re-pick.
 */
export function createCentreSurfaceZoom(
  renderer: ZoomSurfaceRenderer,
  camera: SurfaceZoomCamera & { getOrbitAnchorBounds(): unknown },
  canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>,
  getPickOptions: () => ZoomSurfacePickOptions,
): (delta: number) => void {
  const pickSurface = createZoomSurfacePicker(renderer, camera, getPickOptions);
  let last: { point: SurfacePoint | null; pose: string; pickedAt: number } | null = null;
  return (delta) => {
    if (!(delta < 0)) {
      camera.zoom(delta, false);
      return;
    }
    const now = Date.now();
    let step = last && last.pose === cameraPoseKey(camera) && now - last.pickedAt < SURFACE_PICK_IDLE_MS ? last : null;
    // A live (probe) pick re-picks every step; a miss keeps the known point,
    // which the surface step left on the centre ray.
    if (!step || pickSurface.live?.()) {
      const { width, height } = canvas.getBoundingClientRect();
      const point = width > 0 && height > 0 ? pickSurface(width / 2, height / 2) : null;
      step = step ? { ...step, point: point ?? step.point } : { point, pose: '', pickedAt: now };
    }
    last = step;
    camera.zoom(delta, false, undefined, undefined, undefined, undefined, false, step.point ?? undefined);
    step.pose = cameraPoseKey(camera);
  };
}
