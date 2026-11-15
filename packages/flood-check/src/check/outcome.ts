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
 *   exposed             z <= T + L        the surface is above z whatever the depth in the class
 *   clear               z >  T + U + m    the surface stays below z with margin m to spare
 *   open-ended-class    U is unbounded and z > T + L: no level can be cleared
 *   within-class-range  otherwise (T + L < z <= T + U + m): the class cannot decide it
 *
 * `exposed` uses no margin on purpose: being flagged is the conservative side.
 * Clearing needs the margin, which stands for terrain and georeferencing
 * error (README, "Uncertainty budget").
 */

import type { HazardClassDefinition } from '../types.js';

export type Outcome =
  | 'clear'
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
  /** The terrain source has no height where the governing class was found. */
  | 'no-terrain';

export interface LevelComparison {
  outcome: 'clear' | 'exposed' | 'within-class-range' | 'open-ended-class';
  /** `T + L`: the lowest possible water surface of the class. */
  surfaceLowerBound: number;
  /** `T + U`: the highest possible water surface; null for an open-ended class. */
  surfaceUpperBound: number | null;
  /** `z - (T + L)`; negative or zero means exposed. */
  levelAboveSurfaceLowerBound: number;
  /** `z - (T + U)`; must exceed the margin to clear. Null for an open-ended class. */
  levelAboveSurfaceUpperBound: number | null;
}

/** Compare a level with a class at terrain height `terrain`. Pure; see the module docs for the exact rules. */
export function compareLevel(level: number, terrain: number, cls: HazardClassDefinition, margin: number): LevelComparison {
  const lower = terrain + cls.lowerBound;
  const upper = cls.upperBound === null ? null : terrain + cls.upperBound;
  const aboveLower = level - lower;
  const aboveUpper = upper === null ? null : level - upper;
  let outcome: LevelComparison['outcome'];
  if (level <= lower) outcome = 'exposed';
  else if (upper === null) outcome = 'open-ended-class';
  else if (level > upper + margin) outcome = 'clear';
  else outcome = 'within-class-range';
  return {
    outcome,
    surfaceLowerBound: lower,
    surfaceUpperBound: upper,
    levelAboveSurfaceLowerBound: aboveLower,
    levelAboveSurfaceUpperBound: aboveUpper,
  };
}

/** Order classes by how much water they can mean: unbounded first, then by upper, then by lower bound. */
export function severity(cls: HazardClassDefinition): [number, number] {
  return [cls.upperBound ?? Infinity, cls.lowerBound];
}

export function moreSevere(a: HazardClassDefinition, b: HazardClassDefinition): boolean {
  const [au, al] = severity(a);
  const [bu, bl] = severity(b);
  return au > bu || (au === bu && al > bl);
}
