/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo, Vec3 } from '@ifc-lite/geometry';
import { totalYupOffset, type RenderFrameInfo } from '@ifc-lite/geometry/world-frame';

/** Architectural plan cut height above the storey floor, metres. */
export const DEFAULT_PLAN_CUT_HEIGHT = 1.2;

/**
 * The parts of `GeometryResult.coordinateInfo` that place a storey in the render
 * frame, plus the building's local placement Z relative to the site
 * (`buildingOrigin.z`, metres), which `IfcBuildingStorey.Elevation` is measured from.
 */
export type StoreyCutFrame = RenderFrameInfo & Pick<CoordinateInfo, 'siteOrigin'> & { buildingOrigin?: Pick<Vec3, 'z'> };

/**
 * Render-frame Y of a plan cut `cutHeight` above a storey floor, for
 * `generateFloorPlan`. `storeyElevation` is `IfcBuildingStorey.Elevation` in
 * metres (`SpatialHierarchy.storeyElevations`), which is relative to the
 * building placement; the site's and the building's Z are added and the RTC
 * offset and origin shift the meshes were moved by are taken off (#10931).
 */
export function storeyCutElevation(
  storeyElevation: number,
  cutHeight: number = DEFAULT_PLAN_CUT_HEIGHT,
  frame?: StoreyCutFrame | null,
): number {
  return (frame?.siteOrigin?.z ?? 0) + (frame?.buildingOrigin?.z ?? 0) + storeyElevation + cutHeight - totalYupOffset(frame).y;
}
