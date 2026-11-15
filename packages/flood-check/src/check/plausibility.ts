/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Is the model's height reference plausible against the terrain next to it?
 *
 * Every per-element comparison is an absolute height against terrain, so a
 * wrong `OrthogonalHeight`, a wrong vertical datum or a wrong ground storey
 * shifts every result the same way: 500 m too low makes everything
 * `exposed`, 40 m too high makes everything look favourable. Neither is flood
 * information, so the check refuses instead of reporting.
 *
 * The test: with `Tmin` and `Tmax` the lowest and highest terrain sampled on
 * the rings around every candidate, the ground storey level `g` must satisfy
 *
 *   Tmin - below <= g <= Tmax + above        (defaults below = 1.5 m, above = 2.5 m)
 *
 * Why this band. On a hillside the rings see both the uphill and the downhill
 * terrain, so `Tmin..Tmax` already spans the slope: a walk-out basement (ground
 * floor at the uphill grade, basement at the downhill grade) has `g` near
 * `Tmax` and several metres above `Tmin`, inside the band. `above = 2.5 m`
 * allows a raised ground floor (Hochparterre, typically up to about 1.5 m above
 * grade) plus 1 m for terrain error and sampling; `below = 1.5 m` allows a
 * ground floor sunk below the lowest adjacent grade (a souterrain entrance or
 * a building in a hollow) by up to about 1 m, plus 0.5 m of terrain error. A
 * ground floor wholly below every surrounding grade by more than that, or
 * floating above the highest by more than that, is a height-reference error.
 */

import { FloodCheckRefusal } from '../errors.js';

export interface PlausibilityOptions {
  /** Metres the ground storey may lie below the lowest sampled terrain. Default 1.5. */
  below?: number;
  /** Metres the ground storey may lie above the highest sampled terrain. Default 2.5. */
  above?: number;
}

export interface HeightPlausibility {
  status: 'within-band' | 'not-checked-no-terrain';
  groundStoreyLevel: number;
  terrainMin: number | null;
  terrainMax: number | null;
  /** Ring points with a terrain height. */
  terrainSamples: number;
  below: number;
  above: number;
  /** The test with its numbers. */
  statement: string;
}

const f = (v: number) => v.toFixed(2);

export function assessHeightReference(
  groundStoreyLevel: number,
  terrain: readonly number[],
  options: PlausibilityOptions = {},
): HeightPlausibility {
  const below = options.below ?? 1.5;
  const above = options.above ?? 2.5;
  for (const [name, v] of [['below', below], ['above', above]] as const) {
    if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`heightPlausibility.${name} must be a finite number >= 0, got ${v}`);
  }
  if (terrain.length === 0) {
    return {
      status: 'not-checked-no-terrain',
      groundStoreyLevel,
      terrainMin: null,
      terrainMax: null,
      terrainSamples: 0,
      below,
      above,
      statement: 'not checked: no terrain height at any ground sample',
    };
  }
  let min = Infinity;
  let max = -Infinity;
  for (const t of terrain) {
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  const statement =
    `ground storey ${f(groundStoreyLevel)} m within [${f(min)} - ${below}, ${f(max)} + ${above}] m ` +
    `(lowest and highest of ${terrain.length} terrain samples next to the building)`;
  if (groundStoreyLevel < min - below || groundStoreyLevel > max + above) {
    const side =
      groundStoreyLevel < min - below
        ? `${f(min - groundStoreyLevel)} m below the lowest terrain next to the building (${f(min)} m; band ${below} m)`
        : `${f(groundStoreyLevel - max)} m above the highest terrain next to the building (${f(max)} m; band ${above} m)`;
    throw new FloodCheckRefusal(
      'georeference-implausible',
      `the ground storey level is ${f(groundStoreyLevel)} m, ${side}. This indicates a height-reference error in the model ` +
        "(its OrthogonalHeight, its vertical datum, or the storey taken as ground storey), not flood exposure; " +
        'no element results are reported. Fix the georeferencing or pass groundStorey, or widen heightPlausibility if the building really sits so.',
    );
  }
  return { status: 'within-band', groundStoreyLevel, terrainMin: min, terrainMax: max, terrainSamples: terrain.length, below, above, statement };
}
