/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import { ifcToViewerAxes, totalYupOffset } from '@ifc-lite/geometry/world-frame';
import { modelPointToWorkspacePoint, type PointPlacement } from '@/lib/model-placement/rotation';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation';

/** Source-local Y-up metres to the geometry's current federation render frame. */
export type FederationPointMap = (x: number, y: number, z: number) => readonly [number, number, number] | null;

function displayPointWithOffset(
  coordinate: readonly [number, number, number],
  offset: ReturnType<typeof totalYupOffset>,
  placement: PointPlacement,
  federationMap?: FederationPointMap,
): [number, number, number] {
  const world = ifcToViewerAxes({ x: coordinate[0], y: coordinate[1], z: coordinate[2] });
  const local: readonly [number, number, number] = [world.x - offset.x, world.y - offset.y, world.z - offset.z];
  const aligned = federationMap ? federationMap(...local) : local;
  if (!aligned) throw new RangeError('selected directrix cannot be mapped into the federation frame');
  const displayed = toRenderTranslation(modelPointToWorkspacePoint(
    fromRenderTranslation({ x: aligned[0], y: aligned[1], z: aligned[2] }), placement,
  ));
  if (!displayed.every(Number.isFinite)) throw new RangeError('selected directrix has non-finite display coordinates');
  return [displayed[0], displayed[1], displayed[2]];
}

/** Exact source point in IFC Z-up metres to its displayed Y-up world position. */
export function directrixDisplayPoint(
  coordinate: readonly [number, number, number], sourceFrame: CoordinateInfo | null | undefined,
  placement: PointPlacement, federationMap?: FederationPointMap,
): [number, number, number] {
  return displayPointWithOffset(coordinate, totalYupOffset(sourceFrame), placement, federationMap);
}

/**
 * Convert exact IFC world points through the same three stages as the mesh:
 * source RTC, optional federation alignment, then display placement. Keep
 * every intermediate in f64 until `anchorWorldLineVertices` splits the result.
 */
export function directrixDisplayLines(
  worldLines: readonly number[],
  sourceFrame: CoordinateInfo | null | undefined,
  placement: PointPlacement,
  federationMap?: FederationPointMap,
): number[] {
  const offset = totalYupOffset(sourceFrame);
  const result: number[] = [];
  for (let index = 0; index + 2 < worldLines.length; index += 3) {
    result.push(...displayPointWithOffset(
      [worldLines[index], worldLines[index + 1], worldLines[index + 2]], offset, placement, federationMap,
    ));
  }
  return result;
}
