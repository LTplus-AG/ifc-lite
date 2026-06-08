/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Current-floor projection scoping for 2D floor plans (issue #979 follow-up).
 *
 * The construction projection (issue #979) originally projected the FULL model
 * height on each side of the cut, so every storey's geometry bled onto every
 * plan — a roof two floors up would draw (dashed) on the ground-floor plan.
 * This module scopes the projection bands to the storey the cut sits in.
 *
 * # Coordinate frame (critical)
 * The storey floor levels passed here MUST be derived from MESH geometry in the
 * render frame (the same RTC-shifted, Y-up, metric frame as the section `cut`
 * position) — never from the `IfcBuildingStorey.Elevation` attribute, which
 * omits the building/site placement Z and is wrong for georeferenced models.
 * This module is pure scalar arithmetic and is agnostic to how the levels were
 * obtained; the viewer hook (`useDrawingGeneration`) does the derivation.
 */

import type { ProjectionBandDepths } from './projection-bands.js';

/** Minimal mesh shape needed to derive storey floor levels (structural — avoids
 *  a hard dependency on `@ifc-lite/geometry`'s `MeshData`). */
export interface StoreyFloorMesh {
  readonly expressId: number;
  readonly positions: Float32Array; // interleaved [x, y, z, …] in the render frame
}

/**
 * Per-storey floor levels (ascending) derived from mesh geometry, for
 * current-floor projection scoping (issue #979 follow-up).
 *
 * Each storey's level is the MINIMUM world-Y over its member meshes, read from
 * `positions` in the RTC-shifted render frame — the SAME frame as the section
 * cut position. This deliberately avoids `IfcBuildingStorey.Elevation`, which
 * omits the building/site placement Z and is wrong for georeferenced models.
 *
 * `elementToStorey` keys are LOCAL express ids, so callers must restrict this to
 * single-model use (mesh `expressId` then equals the local id). Storeys whose
 * members produced no mesh contribute no level and are dropped.
 *
 * # Known limitations (bounded; documented intentionally)
 * - The min-Y is the underside of the storey's lowest member, typically the
 *   floor SLAB which conventionally extrudes a little BELOW the level datum — so
 *   the returned level sits ~one slab thickness below the architectural floor.
 *   The effect is a small (~slab-thickness) over-projection at storey
 *   boundaries, not a whole-floor bleed.
 * - An element assigned to an upper storey but geometrically descending into a
 *   lower one (a stair flight, a double-height shaft) pulls that storey's level
 *   down, which can collapse two levels together; the scoping then degrades
 *   toward the unscoped full-extent behavior for that cut — never worse than the
 *   pre-#979-follow-up baseline. A placement-Z / percentile derivation is a
 *   possible future hardening.
 */
export function storeyFloorsFromMeshes(
  meshes: ReadonlyArray<StoreyFloorMesh>,
  elementToStorey: ReadonlyMap<number, number>,
): number[] {
  const storeyMinY = new Map<number, number>();
  for (const mesh of meshes) {
    const storeyId = elementToStorey.get(mesh.expressId);
    if (storeyId === undefined) continue;
    const pos = mesh.positions;
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      if (pos[i] < minY) minY = pos[i];
    }
    if (!Number.isFinite(minY)) continue;
    const cur = storeyMinY.get(storeyId);
    if (cur === undefined || minY < cur) storeyMinY.set(storeyId, minY);
  }
  return [...storeyMinY.values()].sort((a, b) => a - b);
}

/**
 * Compute the construction-projection band depths for the storey containing the
 * cut, given the per-storey floor levels (ascending) and the model's axis
 * extent — all along the cut axis, in the same render-frame metric space as
 * `position`.
 *
 * The current storey `k` is the highest storey whose floor is at or below the
 * cut. Its vertical slab is `[floor_k, ceil_k)`:
 *  - the bottom storey extends DOWN to the model bottom (`axisMin`) so site /
 *    foundation / terrain below the ground floor still projects (solid);
 *  - the top storey extends UP to the model top (`axisMax`) so the roof / eaves
 *    above the top storey still projects (dashed);
 *  - an intermediate storey is clamped to the next storey's floor (its ceiling),
 *    so the floor above is culled.
 *
 * The returned depths feed `ProjectionBandDepths` unchanged: `below` becomes the
 * VISIBLE/solid band (toward the floor) and `above` the OVERHEAD/dashed band.
 * Every depth is floored at `minDepth` so a cut sitting exactly on a storey
 * boundary never yields a zero-width band that culls everything on the plane.
 *
 * @param storeyFloors  Per-storey floor levels along the cut axis, ASCENDING,
 *                      length ≥ 1 (caller should fall back to full-extent bands
 *                      when fewer than 2 storeys exist).
 * @param position      Cut position along the axis (render-frame).
 * @param axisMin       Model minimum along the axis (render-frame).
 * @param axisMax       Model maximum along the axis (render-frame).
 * @param minDepth      Lower clamp for each band depth (default 1 mm).
 */
export function currentFloorBands(
  storeyFloors: number[],
  position: number,
  axisMin: number,
  axisMax: number,
  minDepth = 1e-3,
): ProjectionBandDepths {
  const n = storeyFloors.length;

  // Current storey = highest floor at or below the cut (storeyFloors ascending).
  // A cut below the lowest floor still belongs to the bottom storey (k = 0).
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (storeyFloors[i] <= position) k = i;
    else break;
  }

  const floor = k === 0 ? Math.min(axisMin, storeyFloors[0]) : storeyFloors[k];
  const ceil =
    k === n - 1 ? Math.max(axisMax, storeyFloors[n - 1]) : storeyFloors[k + 1];

  return {
    below: Math.max(position - floor, minDepth),
    above: Math.max(ceil - position, minDepth),
  };
}
