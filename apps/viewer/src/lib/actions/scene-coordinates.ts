/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scene-action coordinates: IFC world (Z-up) in a stated unit → the render
 * frame (Y-up, shifted towards the origin for georeferenced models), plus the
 * plausibility check that refuses anything outside the loaded geometry.
 *
 * The frame rule and the axis swap are `@ifc-lite/geometry/world-frame`'s, the
 * one implementation BCF viewpoints, the measure tool and the SDK share
 * (#4806, #4879): world = viewerToIfcAxes(render) + offset, so
 * render = ifcToViewerAxes(world − offset). Units are converted to metres
 * first; the render frame is always metres.
 */

import { federationFrameInfo, ifcToViewerAxes, renderFrameWorldOffset } from '@ifc-lite/geometry/world-frame';
import type { ViewerState } from '@/store';
import { SCENE_UNITS, type SceneUnit, type Vec3 } from './scene-actions';

export interface RenderPoint { x: number; y: number; z: number }
export interface RenderBounds { min: RenderPoint; max: RenderPoint }

export interface SceneFrame {
  /** Render frame → IFC world translation, Z-up metres. */
  offset: RenderPoint;
  /** Union of the loaded models' render-frame bounds. */
  bounds: RenderBounds;
  /** Distance outside `bounds` still accepted for a cut or a camera target, metres. */
  tolerance: number;
}

type FrameState = Pick<ViewerState, 'models' | 'geometryResult'>;

/** The frame coordinates are validated in, or null when no geometry bounds are known. */
export function sceneFrame(state: FrameState): SceneFrame | null {
  let bounds: RenderBounds | null = null;
  for (const model of state.models.values()) {
    const b = model.geometryResult?.coordinateInfo?.shiftedBounds;
    if (!b || ![b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite)) continue;
    bounds = bounds
      ? { min: { x: Math.min(bounds.min.x, b.min.x), y: Math.min(bounds.min.y, b.min.y), z: Math.min(bounds.min.z, b.min.z) },
        max: { x: Math.max(bounds.max.x, b.max.x), y: Math.max(bounds.max.y, b.max.y), z: Math.max(bounds.max.z, b.max.z) } }
      : { min: { ...b.min }, max: { ...b.max } };
  }
  if (!bounds) {
    const b = state.geometryResult?.coordinateInfo?.shiftedBounds;
    if (b && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite)) bounds = { min: { ...b.min }, max: { ...b.max } };
  }
  if (!bounds) return null;
  const diagonal = Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
  const offset = renderFrameWorldOffset(federationFrameInfo(state.models.values(), state.geometryResult));
  return { offset, bounds, tolerance: Math.max(1, diagonal * 0.1) };
}

/** An IFC world point in `units` → the render frame. */
export function toRenderPoint(point: Vec3, units: SceneUnit, frame: SceneFrame): RenderPoint {
  const scale = SCENE_UNITS[units];
  return ifcToViewerAxes({
    x: point[0] * scale - frame.offset.x,
    y: point[1] * scale - frame.offset.y,
    z: point[2] * scale - frame.offset.z,
  });
}

/** An IFC direction → the render frame's axes, normalised. */
export function toRenderDirection(direction: Vec3): RenderPoint {
  const length = Math.hypot(...direction);
  return ifcToViewerAxes({ x: direction[0] / length, y: direction[1] / length, z: direction[2] / length });
}

/** Is `point` inside `bounds` grown by `margin` on every side? */
export function insideBounds(point: RenderPoint, bounds: RenderBounds, margin: number): boolean {
  return [point.x, point.y, point.z].every(Number.isFinite)
    && point.x >= bounds.min.x - margin && point.x <= bounds.max.x + margin
    && point.y >= bounds.min.y - margin && point.y <= bounds.max.y + margin
    && point.z >= bounds.min.z - margin && point.z <= bounds.max.z + margin;
}

/** The render-frame box for an IFC box: the Z-up → Y-up swap negates one axis, so min/max are re-sorted. */
export function toRenderBox(min: Vec3, max: Vec3, units: SceneUnit, frame: SceneFrame): RenderBounds {
  const a = toRenderPoint(min, units, frame);
  const b = toRenderPoint(max, units, frame);
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

/** Does `box` overlap `bounds` grown by `margin`? */
export function boxesOverlap(box: RenderBounds, bounds: RenderBounds, margin: number): boolean {
  return box.min.x <= bounds.max.x + margin && box.max.x >= bounds.min.x - margin
    && box.min.y <= bounds.max.y + margin && box.max.y >= bounds.min.y - margin
    && box.min.z <= bounds.max.z + margin && box.max.z >= bounds.min.z - margin;
}

/** How far a camera eye may stand from the geometry: a few model diagonals. */
export function cameraReach(frame: SceneFrame): number {
  const b = frame.bounds;
  return Math.max(50, 3 * Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z));
}
