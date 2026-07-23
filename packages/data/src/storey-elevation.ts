// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE definition of storey-elevation semantics (issue #1841).
 *
 * "Which storey is at this Z?" was answered twice: the parser path applied a 1m
 * tolerance and returned null outside it, while the viewer's server-loaded path
 * always snapped to the nearest storey. Same model, same Z, different storey,
 * depending only on which entry path produced it. Both now call in here.
 */

/**
 * Attribute index of `IfcBuildingStorey.Elevation`, the same in IFC2X3 and IFC4:
 *
 * ```
 * [0] GlobalId   [1] OwnerHistory  [2] Name             [3] Description
 * [4] ObjectType [5] ObjectPlacement [6] Representation [7] LongName
 * [8] CompositionType                                   [9] Elevation
 * ```
 *
 * Getting this wrong is silent: slots 7 and 8 hold a string and an enum, so an
 * off-by-one read yields "no elevation" and the UI shows 0 rather than failing.
 * The server's `extract_elevation_if_storey` (Rust) must stay in step with this.
 */
export const IFC_BUILDING_STOREY_ELEVATION_INDEX = 9;

/**
 * Attribute index of `IfcBuildingStorey.ObjectPlacement`, used for the fallback
 * when `Elevation` is null (common in Revit / ArchiCAD exports, see #1289).
 */
export const IFC_BUILDING_STOREY_PLACEMENT_INDEX = 5;

/**
 * How far a Z may sit from a storey's elevation and still resolve to it, in
 * metres.
 *
 * Beyond this the answer is "no storey" rather than "the least-bad storey": a
 * point 40m above the top floor belongs to no storey, and snapping it to the
 * roof silently corrupts storey grouping, floorplan placement, and section cuts.
 */
export const STOREY_ELEVATION_MATCH_TOLERANCE_M = 1.0;

/**
 * Resolve the storey whose elevation is nearest `z`, or `null` when none is
 * within {@link STOREY_ELEVATION_MATCH_TOLERANCE_M}.
 *
 * Exact-distance ties resolve to the lower `storeyId`, NOT to iteration order.
 * That determinism is the point of this being one shared function: the parser
 * and the server-loaded path insert storeys into their maps in different
 * orders, so an order-dependent tie-break would let the same building still
 * answer differently across entry paths — the exact drift #1841 is about.
 *
 * @param storeyElevations - storeyId -> elevation in metres. An empty collection
 *   (the cache-restore path, which has no source buffer) yields `null`.
 * @param z - elevation to match, in metres.
 */
export function findStoreyByElevation(
  storeyElevations: Iterable<readonly [number, number]>,
  z: number
): number | null {
  let closestStorey: number | null = null;
  let closestDistance = Infinity;
  for (const [storeyId, elevation] of storeyElevations) {
    const distance = Math.abs(elevation - z);
    if (
      distance < closestDistance ||
      (distance === closestDistance && closestStorey !== null && storeyId < closestStorey)
    ) {
      closestDistance = distance;
      closestStorey = storeyId;
    }
  }
  return closestDistance < STOREY_ELEVATION_MATCH_TOLERANCE_M ? closestStorey : null;
}
