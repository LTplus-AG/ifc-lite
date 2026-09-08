/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * REPORT a model that is georeferenced TWICE — the user-facing half of #2526.
 *
 * Some authoring tools place the `IfcSite` (and therefore every element under
 * it) at absolute map coordinates via its `IfcLocalPlacement`, AND also emit an
 * `IfcMapConversion` carrying the very same eastings/northings. Per IFC4 the
 * conversion is defined on the `IfcGeometricRepresentationContext`'s world
 * coordinate system, so the spec-strict reading applies it on top of those
 * already-absolute coordinates — adding the offset a second time and flinging
 * the model thousands of km away. Issue #2526: a Vectorworks export in
 * EPSG:25833 (E 311 988 / N 5 996 149) landed in the North Atlantic.
 *
 * ## One threshold, one code path
 *
 * ifc-lite does not render that reading. `effectiveMapConversionForGeometry`
 * ({@link ./map-absolute}) neutralises the duplicated conversion for every
 * geometry-derived consumer, so the model lands where it belongs. This module
 * exists purely to TELL the user that happened — and it must agree with the
 * correction exactly, or the panel ends up describing a model that is not the
 * one on screen.
 *
 * So the fingerprint is NOT re-implemented here. {@link detectDoubleGeoreference}
 * calls the very same guard the geometry pipeline calls and reports iff that
 * guard fired. There is one predicate and one set of constants, and they live
 * with the correction. An earlier version of this module carried its own
 * thresholds (world magnitude >= 100 km, residual <= max(1 km, 0.1% of the
 * offset)); those were close to the guard's but not identical, which left a
 * band of models that would be silently corrected without being flagged, and
 * another that would be flagged without being corrected. (#2526, #2543/#2534
 * reconciliation.)
 */

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

import { computeModelCenterInIfcMeters, effectiveMapConversionForGeometry } from './map-absolute';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from './geo-scale';

export interface DoubleGeoreference {
  /** Model centre in IFC world metres, Z-up (X ≈ easting, Y ≈ northing). */
  worldCenter: { x: number; y: number };
  /** `IfcMapConversion` eastings/northings converted to metres. */
  offset: { easting: number; northing: number };
  /** Distance between the two, metres. Small by construction when reported. */
  residual: number;
  /**
   * How far the duplicated offset WOULD displace the model, in projected
   * metres: the distance from where the geometry already sits in the map CRS
   * to where a spec-strict application of the conversion would put it.
   *
   * Counterfactual, not current state — ifc-lite has already neutralised the
   * conversion by the time this is reported. It is the size of the error the
   * user would see in a tool that applies the file literally, which is what
   * makes it worth quoting: it is the number that explains why this file needs
   * fixing at source.
   *
   * NOT simply ‖offset‖ — the conversion's rotation swings the (already
   * map-sized) world centre around as well. Non-finite when the file authors a
   * non-finite axis or scale; callers must render that as "unknown" rather
   * than a number (see `formatApproxDistance`).
   */
  displacement: number;
  /**
   * True when the neutralised conversion REPLACES a rotation the file actually
   * authors, rather than just restating an already-identity one.
   *
   * The fingerprint matches on translation, so it says nothing about whether
   * the model's local axes are grid-aligned. The guard resets the axis anyway,
   * because a non-identity rotation acting on a map-sized coordinate is
   * unrecoverable whatever the offsets are — but when this is true, the
   * orientation on screen is OUR choice rather than the file's, and callers
   * must say so instead of leaving it implicit.
   *
   * (The site placement's own rotation is NOT taken as corroboration: the
   * placement rotation and the conversion's axis can simply disagree, and they
   * do in #2526 — −117.833° versus +90°.)
   */
  overridesAuthoredRotation: boolean;
  /**
   * Non-null when the neutralised conversion also replaces an authored `Scale`
   * that ifc-lite would otherwise have applied — i.e. the effective horizontal
   * scale for this file is not 1. Left alone it would keep re-scaling the
   * map-sized coordinates about the map origin (a UTM point scale of 0.9996 on
   * a 6 000 km northing is ~2.4 km of drift), so the guard pins it to 1.
   *
   * Carries the `Scale` value the FILE would need for the spec-strict formula
   * to leave its own absolute coordinates alone: the unit bridge
   * `lengthUnitScale / mapUnitScale`. Reported for two reasons — it is a value
   * of the user's file that the placement on screen does not honour, and
   * zeroing only the offsets is then not enough to bake the correction into an
   * export. A spec-compliant consumer reading such a file back would still
   * rescale the map-sized coordinates about the map origin, so any instruction
   * that stops at Eastings/Northings/rotation would be wrong. (PR review.)
   *
   * Null when the effective horizontal scale is already 1, which covers both a
   * spec-correct unit bridge and the unset-Scale heuristic — so a genuine
   * foot/metre bridge is neither overridden nor mentioned.
   */
  scaleForExport: number | null;
}

/**
 * Report a duplicated georeference, or `null` when the model does not match the
 * fingerprint.
 *
 * Fires **iff** {@link effectiveMapConversionForGeometry} neutralised the
 * conversion for the geometry — see the module header. That guard returns its
 * argument unchanged when it does not fire and a fresh object when it does, so
 * reference identity is the exact question "did the placement on screen differ
 * from the file?". `map-absolute.test.ts` pins the unchanged-return half of
 * that contract; `double-georeference.test.ts` pins both halves from here.
 *
 * @param conversion      Effective `IfcMapConversion` (file values + any edits).
 * @param crs             Effective `IfcProjectedCRS` (for `mapUnitScale`).
 * @param coordinateInfo  Geometry bounds + origin/RTC shifts.
 * @param lengthUnitScale IFC project length unit to metres.
 */
export function detectDoubleGeoreference(
  conversion: MapConversion | undefined,
  crs: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  coordinateInfo: CoordinateInfo | undefined,
  lengthUnitScale = 1,
): DoubleGeoreference | null {
  if (!conversion || !coordinateInfo) return null;

  const mapScale = resolveMapUnitToMetreScale(crs?.mapUnitScale, lengthUnitScale);
  const neutralised = effectiveMapConversionForGeometry(conversion, mapScale, coordinateInfo);
  if (neutralised === conversion) return null;

  const easting = conversion.eastings * mapScale;
  const northing = conversion.northings * mapScale;
  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);

  // Where a spec-strict tool would put the model, versus where its geometry
  // already sits in the map CRS. Mirrors `computeProjectedCenter` exactly —
  // including the `?? 1 / ?? 0` axis defaults and the effective (not raw)
  // horizontal scale — so the quoted error is the one such a tool renders.
  //
  // Deliberately NOT guarded against a non-finite axis or Scale. The guard
  // above does not inspect either, so a malformed file is still corrected on
  // screen; bailing here would move it silently and say nothing. Quote "an
  // unknown distance" instead of suppressing the whole message. (#2526.)
  const abscissa = conversion.xAxisAbscissa ?? 1;
  const ordinate = conversion.xAxisOrdinate ?? 0;
  const scale = getEffectiveHorizontalScale(conversion.scale, mapScale, lengthUnitScale);
  const appliedE = easting + scale * (abscissa * ifcX - ordinate * ifcY);
  const appliedN = northing + scale * (ordinate * ifcX + abscissa * ifcY);

  const rotationIsIdentity = Math.abs(abscissa - 1) < 1e-9 && Math.abs(ordinate) < 1e-9;
  // The tolerance is expressed as INDUCED POSITION ERROR, not as a fraction:
  // this scale multiplies a map-sized coordinate, so 0.4% of a 6 000 km
  // easting is 24 km of drift and a fraction-based band would wave it through.
  // One metre at the model's own distance from the origin is what matters.
  const worldMagnitude = Math.hypot(ifcX, ifcY);
  const scaleIsUnit = Math.abs(scale - 1) * worldMagnitude <= 1;
  const mapUnitScale = mapScale > 0 ? mapScale : 1;
  const lengthScale = lengthUnitScale > 0 ? lengthUnitScale : 1;

  return {
    worldCenter: { x: ifcX, y: ifcY },
    offset: { easting, northing },
    residual: Math.hypot(ifcX - easting, ifcY - northing),
    displacement: Math.hypot(appliedE - ifcX, appliedN - ifcY),
    overridesAuthoredRotation: !rotationIsIdentity,
    scaleForExport: scaleIsUnit ? null : lengthScale / mapUnitScale,
  };
}

/**
 * Metres → a short human-readable distance for the sentence the banner builds
 * around it ("about 6,004 km", "about 820 m").
 *
 * The grouping locale is pinned to `en-US` on purpose. The viewer's UI is
 * English-only, and a bare `toLocaleString()` groups in the BROWSER's locale
 * instead: on the reporter's German browser 6 004 km printed as
 * "about 6.004 km", which inside an English sentence reads as six metres. That
 * is the exact text quoted back on #2526 — a real placement error, made to
 * look like a formatting bug. A number embedded in prose has to be formatted
 * in the language of the prose.
 *
 * Past ~2.5 Earth circumferences the figure stops meaning anything to a reader
 * and starts looking like a formatting bug in its own right, so say what it
 * actually implies instead. A file that also mis-scales lands there easily: a
 * 1000× scale on map-sized coordinates produces billions of km.
 */
/**
 * A float as the shortest string that still round-trips to the same value at 6
 * significant figures — `0.001`, not `toPrecision(4)`'s `0.001000`. Used for
 * the `Scale` value the note tells the user to type into a field, where
 * trailing zeros read as a precision claim the number does not carry.
 */
export function trimFloat(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

export function formatApproxDistance(metres: number): string {
  if (!Number.isFinite(metres)) return 'an unknown distance';
  if (metres > 100_000_000) return 'more than a planet-width';
  if (metres >= 1000) return `about ${Math.round(metres / 1000).toLocaleString('en-US')} km`;
  return `about ${Math.round(metres).toLocaleString('en-US')} m`;
}
