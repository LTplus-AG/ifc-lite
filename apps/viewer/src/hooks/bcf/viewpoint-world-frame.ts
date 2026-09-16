/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BCF viewpoints live in IFC world coordinates; the renderer does not (#4806).
 *
 * The geometry pipeline shifts a georeferenced model towards the origin (the
 * wasm RTC offset, then `CoordinateHandler`'s origin shift), so the renderer
 * camera, the section plane and every entity bounding box are in that shifted
 * render frame. BCF `CameraViewPoint` / `ClippingPlane.Location` are world
 * coordinates, and every other BCF tool (BIMcollab, usBIM, Solibri) reads
 * them that way. Writing the render-frame camera put it kilometres from the
 * building there; reading their camera raw did the same here.
 *
 * The rule: a viewpoint held in the store or written to a file is WORLD. It
 * is shifted to world once when captured, and back to the render frame once
 * before anything in the viewer (camera, section plane, overlay markers)
 * consumes it.
 *
 * The frame is resolved by the same rule the measure tool and the Properties
 * panel use (`resolveRenderFrame`): the earliest-loaded model owns the one
 * frame a federation is aligned to.
 */

import {
  translateViewpoint,
  type BCFPoint,
  type BCFProject,
  type BCFTopic,
  type BCFViewpoint,
  type ViewerBounds,
} from '@ifc-lite/bcf';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { resolveRenderFrame } from '../useRenderFrameOffsets';
import { renderToWorldViewer } from '@/components/viewer/tools/measure-modes/coordinates';
import { ifcToViewerAxes, viewerToIfcAxes } from '@/lib/geo/coordinate-frame';

/**
 * Render frame -> IFC world translation, in IFC Z-up metres (the axes BCF
 * positions use). Zero for a model authored near the origin.
 */
export function bcfWorldOffset(
  models: Map<string, FederatedModel>,
  geometryResult: { coordinateInfo?: CoordinateInfo | null } | null | undefined,
): BCFPoint {
  const frame = resolveRenderFrame(models, geometryResult);
  const offset = viewerToIfcAxes(renderToWorldViewer({ x: 0, y: 0, z: 0 }, frame));
  // `viewerToIfcAxes` negates one axis; normalise -0 so "no shift" is exact.
  return { x: offset.x + 0, y: offset.y + 0, z: offset.z + 0 };
}

/** Render-frame bounds of the loaded model(s), Y-up, for section-plane maths. */
export function renderFrameBounds(models: Map<string, FederatedModel>): ViewerBounds | null {
  for (const model of models.values()) {
    const bounds = model.geometryResult?.coordinateInfo?.shiftedBounds;
    if (bounds) return bounds;
  }
  return null;
}

/** A viewpoint captured in the render frame, expressed in world coordinates. */
export function viewpointToWorld(viewpoint: BCFViewpoint, offset: BCFPoint): BCFViewpoint {
  return translateViewpoint(viewpoint, offset);
}

/** Every viewpoint of a freshly built project, moved from the render frame to world. */
export function projectViewpointsToWorld(project: BCFProject, offset: BCFPoint): void {
  for (const topic of project.topics.values()) {
    topic.viewpoints = topic.viewpoints.map((vp) => translateViewpoint(vp, offset));
  }
}

/**
 * A stored (world) viewpoint, expressed in the render frame the viewer draws in.
 *
 * Before #4806 ifc-lite wrote render-frame cameras, and those files and stored
 * projects still exist. For them, subtracting the offset would throw the
 * camera as far off as the bug did in the other direction. The two readings
 * differ by the whole offset, which is only non-zero for coordinates past the
 * 10 km large-coordinate threshold, so whichever reading puts the camera
 * nearer the loaded model is unambiguous in practice. Without a camera or
 * bounds there is nothing to compare, and the file is read as the spec says.
 */
export function viewpointToRenderFrame(
  viewpoint: BCFViewpoint,
  offset: BCFPoint,
  bounds: ViewerBounds | null | undefined,
): BCFViewpoint {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return viewpoint;
  if (isRenderFrameViewpoint(viewpoint, offset, bounds)) return viewpoint;
  return translateViewpoint(viewpoint, { x: -offset.x, y: -offset.y, z: -offset.z });
}

/** A topic whose viewpoints are all in the render frame (for overlay markers). */
export function topicToRenderFrame(
  topic: BCFTopic,
  offset: BCFPoint,
  bounds: ViewerBounds | null | undefined,
): BCFTopic {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return topic;
  return { ...topic, viewpoints: topic.viewpoints.map((vp) => viewpointToRenderFrame(vp, offset, bounds)) };
}

function isRenderFrameViewpoint(
  viewpoint: BCFViewpoint,
  offset: BCFPoint,
  bounds: ViewerBounds | null | undefined,
): boolean {
  const eye = (viewpoint.perspectiveCamera ?? viewpoint.orthogonalCamera)?.cameraViewPoint;
  if (!eye || !bounds) return false;
  const asRenderFrame = distanceToBounds(eye, bounds);
  const asWorld = distanceToBounds({ x: eye.x - offset.x, y: eye.y - offset.y, z: eye.z - offset.z }, bounds);
  return asRenderFrame < asWorld;
}

/** Distance from a BCF (Z-up) point to Y-up viewer bounds; 0 inside. */
function distanceToBounds(p: BCFPoint, bounds: ViewerBounds): number {
  const q = ifcToViewerAxes(p);
  const gap = (v: number, min: number, max: number): number => Math.max(min - v, 0, v - max);
  return Math.hypot(
    gap(q.x, bounds.min.x, bounds.max.x),
    gap(q.y, bounds.min.y, bounds.max.y),
    gap(q.z, bounds.min.z, bounds.max.z),
  );
}
