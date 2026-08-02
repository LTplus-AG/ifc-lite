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
 *  The home zone is determined by centroid containment INDEPENDENTLY of the
 *  `STRADDLE_PENETRATION_M` gate — a sliver-thin element hugging a zone's
 *  outer face (overlap depth below the threshold on its thin axis) still has
 *  an in-zone centroid and MUST classify into that zone, not UNASSIGNED
 *  (review finding on PR #1869; regression tests in assignment.test.ts).
 *  The penetration threshold only decides which ADDITIONAL zones count as
 *  "touched" for the straddle flag.
 *
 *  A degenerate zero-thickness AABB lying EXACTLY on a shared zone boundary
 *  has its centroid on both zones' inclusive boundary, so it deterministically
 *  classifies into the first such zone in set order (ties broken by zone
 *  order, never by float noise) — see the "zero-thickness on boundary" test. */
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
      // Home zone: centroid containment, decided INDEPENDENTLY of the
      // penetration gate below. Gating it behind the straddle threshold
      // wrongly dropped sliver-thin elements whose overlap depth on their
      // thin axis is below STRADDLE_PENETRATION_M even though they sit
      // wholly inside the zone (PR #1869 review).
      const isHome = homeZoneId === null && isPointInCompiledZone(cx, cy, cz, zone);
      if (isHome) {
        homeZoneId = zone.id;
        homeZoneName = zone.name;
      }
      // "Touched" demands real penetration (negative eps) so boundary-abutting
      // elements in tiling zone sets don't flood the straddle flag — see
      // STRADDLE_PENETRATION_M. The home zone always counts as touched.
      if (isHome || zoneOverlapsAABBCompiled(minX, minY, minZ, maxX, maxY, maxZ, zone, -STRADDLE_PENETRATION_M)) {
        touched.push(zone.id);
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
