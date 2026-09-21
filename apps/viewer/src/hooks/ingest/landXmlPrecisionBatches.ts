/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Spatial f32-safe batching for LandXML terrain faces. */

import { MAX_RENDER_FRAME_LOCAL_EXTENT_METRES } from './landXmlRenderFrame.js';
import type { Bounds3D } from '../../utils/localParsingUtils.js';
import type { LandXmlTinSurface } from './landXmlSemantics.js';

/**
 * Split connected terrain faces into f32-safe draw batches before choosing a
 * render frame. Frame admission remains separate: a model spanning
 * [-750 km, +750 km] is valid when geometry can be partitioned, while one
 * giant unpartitioned triangle is not.
 */
export function precisionFaceBatches(
  surface: LandXmlTinSurface,
  faces: LandXmlTinSurface['faces'],
  linearScale: number,
  elevationScale: number,
): Array<LandXmlTinSurface['faces']> {
  const points = new Map(surface.points.map((point) => [point.id, {
    x: point.easting * linearScale,
    y: point.elevation * elevationScale,
    z: -point.northing * linearScale,
  }]));
  const fits = (bounds: Bounds3D): boolean => Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  ) <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES;
  const faceBounds = (face: LandXmlTinSurface['faces'][number]): Bounds3D | null => {
    const vertices = face.map((id) => points.get(id));
    if (vertices.some((point) => point === undefined)) return null;
    const valid = vertices as Array<{ x: number; y: number; z: number }>;
    if (!valid.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z))) return null;
    return {
      min: { x: Math.min(...valid.map((point) => point.x)), y: Math.min(...valid.map((point) => point.y)), z: Math.min(...valid.map((point) => point.z)) },
      max: { x: Math.max(...valid.map((point) => point.x)), y: Math.max(...valid.map((point) => point.y)), z: Math.max(...valid.map((point) => point.z)) },
    };
  };
  const batches: Array<LandXmlTinSurface['faces']> = [];
  let batch: LandXmlTinSurface['faces'] = [];
  let bounds: Bounds3D | null = null;
  for (const face of faces) {
    const next = faceBounds(face);
    if (next === null) {
      if (batch.length) batches.push(batch);
      batches.push([face]);
      batch = [];
      bounds = null;
      continue;
    }
    const merged: Bounds3D = bounds === null ? next : {
      min: { x: Math.min(bounds.min.x, next.min.x), y: Math.min(bounds.min.y, next.min.y), z: Math.min(bounds.min.z, next.min.z) },
      max: { x: Math.max(bounds.max.x, next.max.x), y: Math.max(bounds.max.y, next.max.y), z: Math.max(bounds.max.z, next.max.z) },
    };
    if (batch.length > 0 && !fits(merged)) {
      batches.push(batch);
      batch = [face];
      bounds = next;
    } else {
      batch.push(face);
      bounds = merged;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
