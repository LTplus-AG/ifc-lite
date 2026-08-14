/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantity apportionment for zone-straddling elements (issue #2508, item 1 —
 * the piece #1869 deferred as "the biggest remaining piece of the original
 * ask" in #1810). Given an element's world-space triangles and a zone set,
 * report how much VOLUME of that element sits in each zone.
 *
 * The divergence-theorem clip this is built on — including WHY there is no CSG
 * boolean here, and what the caller must guarantee before any of these numbers
 * mean anything — lives in `./apportionment-clip.js`. This module owns the
 * per-element public API: which zones are worth clipping at all, how the shares
 * are normalised and totalled, and the two conditions ({@link
 * ElementApportionment.overlapping} / {@link ElementApportionment.unreliable})
 * under which the numbers must not be presented as a breakdown that adds up.
 */

import { compileZone, zoneOverlapsAABBCompiled } from './geometry.js';
import type { Zone } from './types.js';
import {
  clippedVolumeForZone,
  meshVolume,
  piecesAabb,
  type ElementMeshPiece,
} from './apportionment-clip.js';
import { clippedVolumeForPrism, compilePrism } from './prism.js';

// Re-exported so `./apportionment-clip.js` stays an implementation detail for
// every existing consumer (`lib/zones/index.ts`, the hook, the tests).
export { clippedVolumeForZone, meshVolume };
export type { ElementMeshPiece };

/** How much of one element sits inside one zone. */
export interface ZoneVolumeShare {
  zoneId: string;
  zoneName: string;
  /** Volume of the element inside this zone, CUBIC METRES (viewer frame). */
  volumeM3: number;
  /** `volumeM3 / wholeVolumeM3`, in [0, 1] for a zone set whose zones do not
   *  overlap each other. This is the number to multiply a DECLARED quantity by
   *  — see `volume-basis.ts`. */
  fraction: number;
}

/** Per-element apportionment across one zone set. */
export interface ElementApportionment {
  /** Volume of the whole element, cubic metres, computed from the SAME
   *  triangles by the same divergence sum — so `shares` and this number are
   *  self-consistent even when the mesh disagrees with a declared QTO. */
  wholeVolumeM3: number;
  /** One entry per zone with a non-negligible share, in zone-set order. Zones
   *  the element only abuts are omitted, matching v1's negative-epsilon
   *  straddle convention. */
  shares: ZoneVolumeShare[];
  /** Volume in no zone of this set. `max(0, whole - sum(shares))`, so it is
   *  never negative even when `overlapping` is true. */
  outsideVolumeM3: number;
  /** `outsideVolumeM3 / wholeVolumeM3`. */
  outsideFraction: number;
  /**
   * True when the shares sum to MORE than the whole element (past
   * {@link SUM_TOLERANCE_REL}), which can only happen when the zones in the set
   * overlap each other. The per-zone numbers are still individually correct;
   * they just double-count the overlap, so they must not be presented as a
   * breakdown that adds up. Nothing forbids overlapping zones in v1, so this
   * has to be reported rather than assumed away.
   */
  overlapping: boolean;
  /**
   * True when a zone produced a NEGATIVE clipped volume big enough to matter.
   * A closed, orientable, single-component mesh cannot do that, so this only
   * fires when the caller ignored the closure gate described in the module
   * doc. Surfaced rather than clamped away, because a silently clamped
   * negative is exactly the confidently-wrong number #1993's gate exists to
   * refuse.
   */
  unreliable: boolean;
}

/**
 * Relative tolerance for "the shares sum to the whole".
 *
 * The divergence sum is exact in exact arithmetic. On SYNTHETIC f64 meshes the
 * residual is f64 accumulation noise, measured at ~4e-16 relative. On real
 * renderer meshes it is not: `MeshData.positions` is a **Float32Array**, so
 * vertices that a closed shell shares are only equal to f32 precision and the
 * surface has micron-scale cracks the sum leaks through. Measured over 241
 * straddling elements of `01_Snowdon_Towers_Sample_Structural(1).ifc`: median
 * 3.9e-16, p99 1.2e-6, max 3.4e-6 (an absolute 2.15e-6 m3 on a 0.638 m3 slab).
 *
 * 1e-4 leaves ~30x headroom over that measured worst case while still being
 * three orders of magnitude tighter than any real zone overlap, which
 * double-counts whole fractions of an element rather than parts per million.
 */
export const SUM_TOLERANCE_REL = 1e-4;

/**
 * A zone's share is dropped when it is below this fraction of the element's
 * whole volume. Two distinct things land here and both must be dropped:
 *
 *  - A zone the element merely ABUTS. The intersection is a zero-thickness
 *    slice, so its exact volume is 0 — but the clip's f64 arithmetic can land
 *    on +/-1e-17 instead, and a share of -1e-17 m3 is not a share. This is the
 *    common case in takt planning, where zone sets tile a building sharing
 *    exact boundary planes, and it is how apportionment agrees with v1's
 *    NEGATIVE straddle epsilon without duplicating the threshold.
 *  - A genuine but vanishing sliver of overlap, which is noise a reader would
 *    have to mentally discard anyway.
 *
 * Measured clip noise on a zone that holds none of the element is 2.1e-14
 * relative (400 randomised f64 trials); 1e-9 clears that by five orders of
 * magnitude while still discarding only nanolitre slivers.
 */
export const NEGLIGIBLE_SHARE_REL = 1e-9;

/**
 * Apportion one element's volume across the zones of one set.
 *
 * Zones whose oriented box does not reach the element's AABB are skipped
 * without touching a triangle, so the cost is `O(triangles x zones the element
 * actually reaches)`, not `O(triangles x zones)`. The AABB prefilter uses an
 * INCLUSIVE epsilon (unlike v1's straddle test, which is deliberately
 * exclusive): a zone that only abuts still gets clipped, and then drops out on
 * its own zero volume via {@link NEGLIGIBLE_SHARE_REL}. Filtering it out early
 * with v1's negative epsilon instead would silently move a real sliver of
 * volume into `outsideVolumeM3`.
 *
 * Sign is normalised against the whole-mesh volume, so a mesh wound inward
 * throughout (the viewer renders double-sided and does not guarantee outward
 * winding) yields positive shares and a positive whole. A mesh with
 * INCONSISTENT winding cannot be rescued by a global sign and its numbers are
 * meaningless — that is the population the closure gate in the module doc
 * excludes, and `unreliable` catches what slips through.
 */
export function apportionElementVolume(
  pieces: readonly ElementMeshPiece[],
  zones: readonly Zone[],
): ElementApportionment {
  const rawWhole = meshVolume(pieces);
  const sign = rawWhole < 0 ? -1 : 1;
  const wholeVolumeM3 = rawWhole * sign;
  const negligible = wholeVolumeM3 * NEGLIGIBLE_SHARE_REL;
  const aabb = wholeVolumeM3 > 0 ? piecesAabb(pieces) : null;

  const shares: ZoneVolumeShare[] = [];
  let assigned = 0;
  let unreliable = false;
  if (aabb) {
    for (const zone of zones) {
      const compiled = compileZone(zone);
      if (!zoneOverlapsAABBCompiled(aabb[0], aabb[1], aabb[2], aabb[3], aabb[4], aabb[5], compiled)) continue;
      // A prism integrates the same way against a different decomposition of
      // the same field (see `prism.ts`). Routed here rather than inside the box
      // clipper so the measured box path keeps its shape exactly.
      const v = (zone.footprint
        ? clippedVolumeForPrism(pieces, compilePrism(zone.footprint, compiled.minY, compiled.maxY))
        : clippedVolumeForZone(pieces, compiled)) * sign;
      if (!Number.isFinite(v) || v <= negligible) {
        if (v < -negligible) unreliable = true;
        continue;
      }
      shares.push({
        zoneId: zone.id,
        zoneName: zone.name,
        volumeM3: v,
        fraction: v / wholeVolumeM3,
      });
      assigned += v;
    }
  }

  const overlapping = wholeVolumeM3 > 0 && assigned > wholeVolumeM3 * (1 + SUM_TOLERANCE_REL);
  const outsideVolumeM3 = Math.max(0, wholeVolumeM3 - assigned);
  return {
    wholeVolumeM3,
    shares,
    outsideVolumeM3,
    outsideFraction: wholeVolumeM3 === 0 ? 0 : outsideVolumeM3 / wholeVolumeM3,
    overlapping,
    unreliable,
  };
}
