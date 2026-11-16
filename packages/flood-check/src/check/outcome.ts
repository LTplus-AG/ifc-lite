/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a depth CLASS can and cannot support.
 *
 * A class is a half-open interval `(L, U]` of water depth above terrain `T`,
 * so the water surface lies in `(T + L, T + U]`. For an element whose lowest
 * relevant level is `z`, with a clearance margin `m`:
 *
 *   exposed                   z <= T + L      the surface is above z whatever the depth in the class
 *   above-mapped-class-range  z >  T + U + m  the class's highest surface stays below z with margin m to spare
 *   open-ended-class          U is unbounded and z > T + L: no level can be shown above it
 *   within-class-range        otherwise (T + L < z <= T + U + m): the class cannot decide it
 *
 * This compares ONE ground sample. `checkFloodExposure` compares every
 * classified sample next to an element, each with its own terrain and class,
 * and combines them (see `evaluate.ts`). `exposed` uses no margin on purpose:
 * being flagged is the conservative side. The favourable outcome needs the
 * margin, derived from the stated uncertainties (`margin.ts`); it states only
 * that the element is above the range of the class the map shows there.
 */

import type { HazardClassDefinition } from '../types.js';

export type Outcome =
  | 'above-mapped-class-range'
  | 'exposed'
  | 'within-class-range'
  | 'open-ended-class'
  | 'no-runoff-mapped'
  | 'unclassified';

export type UnclassifiedReason =
  /** Every usable ground sample is an antialiased edge pixel or a mix of edge pixels and "no runoff". */
  | 'map-edge-blend'
  /** Samples fell outside the retrieved raster. */
  | 'outside-raster'
  /** No ring point lies outside the footprint (for example a courtyard narrower than the rings). */
  | 'no-ground-sample'
  /** The area is excluded from the model (for example glacier). */
  | 'excluded-area'
  /** The terrain source has no height at any ground sample showing a class. */
  | 'no-terrain'
  /** Every readable ground sample lies outside, or too close to, the perimeter the map covers: transparent there means no data. */
  | 'outside-coverage'
  /** No cell of the raster shows a mapped class (only transparent or edge pixels) and the provider could not confirm that the layer is rendering. */
  | 'layer-not-confirmed'
  /** Every sample is transparent, but the element had to be moved further than the anchor tolerance to reach the outline. */
  | 'anchor-moved'
  /** Every sample is transparent, but the footprint is a hull, so the ground sampled may not be in front of the element. */
  | 'hull-footprint'
  /** Every sample is transparent, but the nearest footprint boundary is a courtyard ring the footprint fills, so the ground in front of the element was not sampled. */
  | 'courtyard-ring'
  /** Every sample is transparent, but the footprint may miss part of the building (a source that cannot be read, or no rings at all). */
  | 'partial-footprint'
  /** A ground sample lies inside another building, which the hazard model raised: not modelled there. */
  | 'other-building'
  /** Transparent samples, but no complete source of other buildings' footprints was supplied: they may lie inside one. */
  | 'other-buildings-unknown'
  /** The element's position is not proven (`CandidateFact.positionIsUncertain`), so the ground sampled may not be in front of it. */
  | 'position-uncertain'
  /** Every sample is transparent, but the model's height reference (and so its georeference) could not be confirmed. */
  | 'height-reference-unconfirmed'
  /** Every sample is transparent, but the element's level is only an upper estimate. */
  | 'level-upper-estimate'
  /** Every sample is transparent, but the terrain source states no vertical accuracy, so no reassuring outcome is given. */
  | 'margin-not-sized';

export interface LevelComparison {
  outcome: 'above-mapped-class-range' | 'exposed' | 'within-class-range' | 'open-ended-class';
  /** `T + L`: the lowest possible water surface of the class. */
  surfaceLowerBound: number;
  /** `T + U`: the highest possible water surface; null for an open-ended class. */
  surfaceUpperBound: number | null;
  /** `z - (T + L)`; negative or zero means exposed. */
  levelAboveSurfaceLowerBound: number;
  /** `z - (T + U)`; must exceed the margin for `above-mapped-class-range`. Null for an open-ended class. */
  levelAboveSurfaceUpperBound: number | null;
}

/**
 * Compare a level with a class at terrain height `terrain`. Pure; see the
 * module docs for the exact rules. A `margin` of `Infinity` never yields the
 * favourable outcome (used when the margin cannot be sized).
 */
export function compareLevel(level: number, terrain: number, cls: HazardClassDefinition, margin: number): LevelComparison {
  if (!(margin >= 0)) throw new RangeError(`margin must be >= 0 (Infinity allowed), got ${margin}`);
  // Every comparison with a non-finite level is false or true by accident (Infinity > anything), never by evidence.
  if (!Number.isFinite(level) || !Number.isFinite(terrain)) throw new RangeError(`level and terrain must be finite, got level ${level}, terrain ${terrain}`);
  const lower = terrain + cls.lowerBound;
  const upper = cls.upperBound === null ? null : terrain + cls.upperBound;
  const aboveLower = level - lower;
  const aboveUpper = upper === null ? null : level - upper;
  let outcome: LevelComparison['outcome'];
  if (level <= lower) outcome = 'exposed';
  else if (upper === null) outcome = 'open-ended-class';
  else if (level > upper + margin) outcome = 'above-mapped-class-range';
  else outcome = 'within-class-range';
  return {
    outcome,
    surfaceLowerBound: lower,
    surfaceUpperBound: upper,
    levelAboveSurfaceLowerBound: aboveLower,
    levelAboveSurfaceUpperBound: aboveUpper,
  };
}
