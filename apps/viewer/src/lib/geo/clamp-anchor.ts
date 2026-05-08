/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clamp anchor selection.
 *
 * "Auto-clamp to terrain" needs to decide WHICH viewer-Y of the model
 * should be pinned to the terrain surface. The naïve choice — `bounds.min.y`
 * — anchors the lowest geometry vertex (typically the bottom of the
 * basement / foundation) to terrain, which buries the building's
 * actual ground floor below the surface.
 *
 * Better: pick the IfcBuildingStorey whose elevation is closest to 0
 * (the conventional "ground floor"). Fall back to `bounds.min.y` when
 * no storeys are present or none lie within the model's vertical
 * extent — that preserves the previous behaviour for non-architectural
 * IFCs (structural-only models, civil works, point clouds, etc.).
 */

interface BoundsLike {
  min: { y: number };
  max: { y: number };
}

/**
 * @param bounds            Model bounds in viewer-space (Y-up, metres).
 * @param storeyElevations  IFC storey elevations (metres, viewer-Y aligned).
 *                          The geometry pipeline already converts IFC Z-up
 *                          values to viewer-Y, so values here can be
 *                          compared against `bounds.min.y` / `max.y`.
 *
 * @returns viewer-Y altitude that should land at terrain when clamping.
 */
export function findClampAnchorY(
  bounds: BoundsLike | undefined,
  storeyElevations: Map<number, number> | undefined,
): number {
  const minY = bounds?.min.y ?? 0;
  if (!storeyElevations || storeyElevations.size === 0) return minY;

  const maxY = bounds?.max.y ?? minY;
  const slack = 1; // metre — tolerate storey markers slightly outside the AABB
  let bestElevation: number | null = null;
  let bestDistanceFromZero = Infinity;
  for (const elevation of storeyElevations.values()) {
    if (!Number.isFinite(elevation)) continue;
    if (elevation < minY - slack || elevation > maxY + slack) continue;
    const distance = Math.abs(elevation);
    if (distance < bestDistanceFromZero) {
      bestDistanceFromZero = distance;
      bestElevation = elevation;
    }
  }

  return bestElevation ?? minY;
}
