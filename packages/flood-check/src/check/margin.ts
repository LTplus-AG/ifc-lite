/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The clearance margin, derived from stated uncertainties:
 *
 *   m = max(floor, 2 * sqrt(sigmaTerrain^2 + classResolution^2 + sigmaGeoreference^2))
 *
 * - `sigmaTerrain`: the terrain source's own 1-sigma vertical accuracy
 *   (`TerrainSource.verticalAccuracy`). swissALTI3D states 0.3 m (new LiDAR),
 *   0.5 m (older LiDAR, below 2,000 m) and 1 to 3 m (stereo correlation,
 *   above 2,000 m).
 * - `classResolution`: 0.25 m, the span of the bounded BAFU depth classes
 *   (0 to 0.25 m in two steps): the map cannot say more finely where in that
 *   range the water stands, and its 2 m smoothed terrain is not the terrain
 *   sampled here.
 * - `sigmaGeoreference`: 1-sigma vertical error of the model's height
 *   reference (`OrthogonalHeight`, the ground storey, the threshold). Nothing
 *   in a model shows whether its height reference was surveyed, so the
 *   default is a conservative 0.5 m (an estimated map conversion). A caller
 *   who knows the height reference is surveyed states it with
 *   `georeferenceVerticalUncertainty` (for example 0.05 m): that is supplying
 *   information, and the basis is recorded as `stated-by-caller`.
 * - `floor`: 0.5 m, or the caller's `clearanceMargin` when larger. A caller
 *   can raise the margin, never lower it below the derived value.
 *
 * Twice the root-sum-square is a two-sigma bound under independent, normal
 * errors. Without a stated terrain accuracy there is nothing to size the
 * margin with, so the favourable outcome is not given at all.
 */

export interface MarginOptions {
  /** Minimum clearance margin in metres; raises the floor of 0.5 m, never lowers it. */
  clearanceMargin?: number;
  /** Depth resolution of the map's classes, metres. Default 0.25; may only be raised. */
  classResolution?: number;
  /**
   * 1-sigma vertical error of the model's height reference, metres, as the
   * caller knows it (for example 0.05 for a surveyed map conversion).
   * Default 0.5 when not stated: nothing in the model shows it was surveyed.
   */
  georeferenceVerticalUncertainty?: number;
}

export interface MarginBasis {
  /** The margin used, metres; null when it cannot be sized (no stated terrain accuracy). */
  margin: number | null;
  floor: number;
  terrainAccuracy: number | null;
  classResolution: number;
  georeferenceVerticalUncertainty: number;
  /** Whether the georeferencing term was stated by the caller or is the conservative default. */
  georeferenceBasis: 'stated-by-caller' | 'default-not-surveyed';
  /** `2 * sqrt(...)`; null without a terrain accuracy. */
  twoSigma: number | null;
  /** The formula with its numbers, for property sets and reports. */
  statement: string;
}

export const MARGIN_FLOOR = 0.5;
export const CLASS_RESOLUTION = 0.25;
/** The georeferencing term when the caller states none: an estimated, not a surveyed, height reference. */
export const DEFAULT_GEOREFERENCE_UNCERTAINTY = 0.5;

function nonNegative(name: string, value: number): number {
  if (!(value >= 0) || !Number.isFinite(value)) throw new RangeError(`${name} must be a finite number >= 0, got ${value}`);
  return value;
}

export function deriveClearanceMargin(terrainAccuracy: number | undefined, options: MarginOptions = {}): MarginBasis {
  const floor = Math.max(MARGIN_FLOOR, nonNegative('clearanceMargin', options.clearanceMargin ?? MARGIN_FLOOR));
  const classResolution = nonNegative('classResolution', options.classResolution ?? CLASS_RESOLUTION);
  if (classResolution < CLASS_RESOLUTION) {
    throw new RangeError(`classResolution may only be raised (default ${CLASS_RESOLUTION} m), got ${classResolution}`);
  }
  const stated = options.georeferenceVerticalUncertainty;
  const geo = nonNegative('georeferenceVerticalUncertainty', stated ?? DEFAULT_GEOREFERENCE_UNCERTAINTY);
  const georeferenceBasis: MarginBasis['georeferenceBasis'] = stated === undefined ? 'default-not-surveyed' : 'stated-by-caller';
  const geoWords = georeferenceBasis === 'stated-by-caller' ? 'georeferencing as stated by the caller' : 'georeferencing, default for a height reference not stated to be surveyed';
  if (terrainAccuracy === undefined || !Number.isFinite(terrainAccuracy) || terrainAccuracy < 0) {
    return {
      margin: null,
      floor,
      terrainAccuracy: null,
      classResolution,
      georeferenceVerticalUncertainty: geo,
      georeferenceBasis,
      twoSigma: null,
      statement:
        'not sized: the terrain source states no vertical accuracy, so no element is reported above the mapped class range',
    };
  }
  const twoSigma = 2 * Math.sqrt(terrainAccuracy ** 2 + classResolution ** 2 + geo ** 2);
  const margin = Math.max(floor, twoSigma);
  const f = (v: number) => v.toFixed(3).replace(/\.?0+$/, '');
  return {
    margin,
    floor,
    terrainAccuracy,
    classResolution,
    georeferenceVerticalUncertainty: geo,
    georeferenceBasis,
    twoSigma,
    statement:
      `max(${f(floor)}, 2 * sqrt(${f(terrainAccuracy)}^2 + ${f(classResolution)}^2 + ${f(geo)}^2)) = ` +
      `max(${f(floor)}, ${f(twoSigma)}) = ${f(margin)} m (terrain accuracy, class resolution, ${geoWords}; 1 sigma)`,
  };
}
