/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element-to-zone classification (issue #1810 v1). Pure and side-effect
 * free so it's unit-testable without a loaded model or a renderer: callers
 * (the viewer store) are responsible for gathering `ElementAABB[]` across
 * every federated model and feeding it in here.
 *
 * Complexity is O(elements × zones-in-set) per zone set — see
 * `zoneOverlapsAABB` for why each check is cheap (two 1-D/2-D interval
 * tests, no matrix work). Measured cost for a synthetic 100k-element /
 * 20-zone workload is recorded in the PR description; this runs on the main
 * thread (no worker) because it stays well under the 100ms budget in
 * AGENTS.md's quality bar.
 */

import { compileZone, isPointInCompiledZone, zoneOverlapsAABBCompiled } from './geometry.js';
import type { ElementAABB, ZoneAssignment, ZoneAssignmentsByElement, ZoneSet } from './types.js';

const UNASSIGNED: ZoneAssignment = {
  zoneId: null,
  zoneName: null,
  straddles: false,
  touchedZoneIds: [],
};

/**
 * Minimum overlap depth (metres) an element's AABB must penetrate a zone by,
 * on every SAT axis, to count as "touching" that zone for straddle purposes.
 *
 * The primary use case is zone SETS THAT TILE the building — takt areas /
 * construction sections sharing exact boundary planes. A wall or slab
 * ending exactly at that shared boundary is the common case, not the
 * exception: its AABB abuts, but does not penetrate, the neighbouring zone.
 * `zoneOverlapsAABBCompiled`'s default epsilon is INCLUSIVE (a positive
 * slack that treats exact/near contact as overlap, which is what the
 * home-zone containment test wants), so using it here would flag nearly
 * every boundary-adjacent element as straddling with zero actual overlap —
 * flooding the flag on precisely the models this feature targets. Passing
 * a NEGATIVE epsilon (see `zoneOverlapsAABBCompiled`'s doc) instead demands
 * real penetration past this threshold before two zones are both "touched".
 */
export const STRADDLE_PENETRATION_M = 0.001;

/** Classify every element in `elements` against every zone in `zoneSet`.
 *  Each zone's trig/half-extents are compiled once (not once per element),
 *  so this is `O(elements x zones-in-set)` cheap scalar arithmetic — no
 *  allocation in the inner loop. See `geometry.ts`'s `CompiledZone` doc for
 *  why that matters at scale.
 *
 *  A degenerate, zero-thickness AABB lying EXACTLY on a shared zone
 *  boundary (e.g. a flattened/collapsed element) penetrates neither
 *  neighbour by `STRADDLE_PENETRATION_M`, so it touches no zone and
 *  classifies UNASSIGNED rather than straddling or picking an arbitrary
 *  side — see the "zero-thickness on boundary" test in assignment.test.ts. */
export function assignElementsToZoneSet(
  elements: readonly ElementAABB[],
  zoneSet: ZoneSet,
): Map<number, ZoneAssignment> {
  const out = new Map<number, ZoneAssignment>();
  const zones = zoneSet.zones;
  if (zones.length === 0) {
    for (const el of elements) out.set(el.globalId, UNASSIGNED);
    return out;
  }

  const compiled = zones.map(compileZone);

  for (const el of elements) {
    const [minX, minY, minZ] = el.min;
    const [maxX, maxY, maxZ] = el.max;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    let homeZoneId: string | null = null;
    let homeZoneName: string | null = null;
    const touched: string[] = [];

    for (const zone of compiled) {
      // Real penetration only (negative eps) — see STRADDLE_PENETRATION_M.
      // Centroid-inside implies deep overlap for any non-degenerate AABB, so
      // this gate essentially never disagrees with the (separately, more
      // loosely) tested home-zone containment below — except exactly the
      // zero-thickness-on-a-boundary case documented above.
      if (!zoneOverlapsAABBCompiled(minX, minY, minZ, maxX, maxY, maxZ, zone, -STRADDLE_PENETRATION_M)) continue;
      touched.push(zone.id);
      if (homeZoneId === null && isPointInCompiledZone(cx, cy, cz, zone)) {
        homeZoneId = zone.id;
        homeZoneName = zone.name;
      }
    }

    const straddles = touched.length > 1 || (touched.length === 1 && homeZoneId === null);
    out.set(el.globalId, touched.length === 0
      ? UNASSIGNED
      : { zoneId: homeZoneId, zoneName: homeZoneName, straddles, touchedZoneIds: touched });
  }

  return out;
}

/** Classify every element against every zone set, keyed `globalId ->
 *  (zoneSetId -> ZoneAssignment)`. A zone set with zero zones still gets an
 *  entry per element (all `UNASSIGNED`) so callers (e.g. the Lists column)
 *  can tell "the set exists but this element matched nothing" apart from
 *  "the set doesn't exist". */
export function assignElementsToZoneSets(
  elements: readonly ElementAABB[],
  zoneSets: readonly ZoneSet[],
): ZoneAssignmentsByElement {
  const perSet = zoneSets.map((zs) => ({ id: zs.id, result: assignElementsToZoneSet(elements, zs) }));
  const out: ZoneAssignmentsByElement = new Map();
  for (const el of elements) {
    const record: Record<string, ZoneAssignment> = {};
    for (const { id, result } of perSet) {
      record[id] = result.get(el.globalId) ?? UNASSIGNED;
    }
    out.set(el.globalId, record);
  }
  return out;
}
