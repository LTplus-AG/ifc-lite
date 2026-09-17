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
 * panel use (`federationFrameInfo`, which `resolveRenderFrame` also calls):
 * the earliest-loaded model owns the one frame a federation is aligned to.
 */

import {
  translateViewpoint,
  viewpointFromWorld,
  type BCFPoint,
  type BCFProject,
  type BCFTopic,
  type ViewerBounds,
} from '@ifc-lite/bcf';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { federationFrameInfo, renderFrameWorldOffset } from '@ifc-lite/geometry/world-frame';
import type { FederatedModel } from '@/store/types';

/**
 * Render frame -> IFC world translation, in IFC Z-up metres (the axes BCF
 * positions use). Zero for a model authored near the origin. The frame rule
 * and the arithmetic are `@ifc-lite/geometry`'s, shared with the CLI, the MCP
 * playground and the SDK (#4879).
 */
export function bcfWorldOffset(
  models: Map<string, FederatedModel>,
  geometryResult: { coordinateInfo?: CoordinateInfo | null } | null | undefined,
): BCFPoint {
  return renderFrameWorldOffset(federationFrameInfo(models.values(), geometryResult));
}

/** Render-frame bounds of the loaded model(s), Y-up, for section-plane maths. */
export function renderFrameBounds(models: Map<string, FederatedModel>): ViewerBounds | null {
  for (const model of models.values()) {
    const bounds = model.geometryResult?.coordinateInfo?.shiftedBounds;
    if (bounds) return bounds;
  }
  return null;
}

/** Every viewpoint of a freshly built project, moved from the render frame to world. */
export function projectViewpointsToWorld(project: BCFProject, offset: BCFPoint): void {
  for (const topic of project.topics.values()) {
    topic.viewpoints = topic.viewpoints.map((vp) => translateViewpoint(vp, offset));
  }
}

/** A topic whose viewpoints are all in the render frame (for overlay markers). */
export function topicToRenderFrame(
  topic: BCFTopic,
  offset: BCFPoint,
  bounds: ViewerBounds | null | undefined,
): BCFTopic {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return topic;
  return { ...topic, viewpoints: topic.viewpoints.map((vp) => viewpointFromWorld(vp, offset, bounds)) };
}
