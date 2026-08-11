/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detect a model that is georeferenced TWICE.
 *
 * Some authoring tools place the `IfcSite` (and therefore every element under
 * it) at absolute map coordinates via its `IfcLocalPlacement`, AND also emit an
 * `IfcMapConversion` carrying the very same eastings/northings. Per IFC4 the
 * conversion is defined on the `IfcGeometricRepresentationContext`'s world
 * coordinate system, so the correct reading is to apply it on top of those
 * already-absolute coordinates — which adds the offset a second time and flings
 * the model roughly `‖(E, N)‖` away from where it belongs. Issue #2526: a
 * Vectorworks export of a site in Rostock (E 311 988 / N 5 996 149, EPSG:25833)
 * landed at 33.71 N / -49.12 E, ~5 200 km out in the North Atlantic, on an empty
 * basemap.
 *
 * The fingerprint is unusually crisp, which is why this is a translation match
 * rather than an "is the result inside the CRS's area of use" test (we ship no
 * area-of-use extents, and that test has a far larger false-positive surface):
 *
 *   1. the model's world centre is itself already map-sized (>= 100 km from the
 *      IFC origin — no ordinary local-frame model is), AND
 *   2. that centre coincides with the MapConversion offset to within a
 *      tolerance that a duplicated value clears trivially and an independent
 *      value essentially never does.
 *
 * A correctly authored absolute-coordinate model (buildingSMART LoGeoRef 20/30)
 * fails (2) precisely because its conversion offset is 0/0, so it is not
 * flagged. A correctly authored local-frame model fails (1).
 *
 * This module only REPORTS. Nothing here changes placement: the viewer keeps
 * rendering the file as authored, and the georeferencing panel offers the user
 * a one-click correction.
 */

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

import { computeModelCenterInIfcMeters } from './reproject';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from './geo-scale';

/**
 * How far the model centre must sit from the IFC origin before a coincidence
 * with the MapConversion offset means anything. A local-frame building model
 * lives within a few km of its origin; 100 km is comfortably clear of even a
 * sprawling site or an infrastructure alignment, while every map-coordinate
 * easting/northing pair worth worrying about is in the 10^5..10^7 m range.
 */
const MIN_WORLD_MAGNITUDE_M = 100_000;

/**
 * Absolute floor on the coincidence tolerance. The model CENTRE is compared
 * against the offset, and the offset is normally the site/project origin, so
 * the two differ by roughly half the model's plan extent. 1 km covers any
 * building and most sites outright.
 */
const MIN_RESIDUAL_TOLERANCE_M = 1_000;

/**
 * Relative part of the coincidence tolerance, applied to the magnitude of the
 * offset. Keeps large-extent models (infrastructure alignments, whole
 * districts) inside the tolerance without widening it for small coordinates.
 */
const RESIDUAL_TOLERANCE_FRACTION = 0.001;

export interface DoubleGeoreference {
  /** Model centre in IFC world metres, Z-up (X ≈ easting, Y ≈ northing). */
  worldCenter: { x: number; y: number };
  /** `IfcMapConversion` eastings/northings converted to metres. */
  offset: { easting: number; northing: number };
  /** Distance between the two, metres. Small by construction when flagged. */
  residual: number;
  /**
   * How far the duplicated offset displaces the model, in projected metres:
   * the distance from where the geometry already sits in the map CRS to where
   * applying the conversion puts it. This is the size of the error the user
   * sees, and it is NOT simply ‖offset‖ — the conversion's rotation swings the
   * (already map-sized) world centre around as well.
   */
  displacement: number;
  /**
   * Whether we can corroborate that clearing the conversion's ROTATION is safe,
   * as opposed to only its translation.
   *
   * The fingerprint below matches on translation alone, so on its own it does
   * not prove the model's local axes are grid-aligned. Two cases make the
   * rotation reset unambiguous, and this flag marks them:
   *
   *   - the authored rotation is already the identity, so there is nothing to
   *     reset; or
   *   - the geometry's own placement carries a rotation
   *     (`CoordinateInfo.buildingRotation`, baked into the world coordinates by
   *     the geometry pipeline). That rotation is exactly what turns the site's
   *     local frame INTO the map frame, so the world axes are grid axes and the
   *     conversion's rotation is redundant. This is the reporter's file
   *     (#2526): site X axis (-0.46689605, -0.88431221), i.e. -117.833°.
   *
   * When it is false the file cannot be reconciled at all — a non-identity
   * rotation applied to map-sized world coordinates swings the model thousands
   * of km whatever the translation is, so no choice of offsets rescues it — but
   * the ORIENTATION the fix lands on (grid-aligned) is then our choice rather
   * than the file's. Callers must say so instead of applying it silently.
   */
  rotationCorroborated: boolean;
}

/**
 * Report a duplicated georeference, or `null` when the model does not match the
 * fingerprint. See the module header for the two conditions and why they are
 * safe against correctly authored files.
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
  const easting = conversion.eastings * mapScale;
  const northing = conversion.northings * mapScale;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) return null;

  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);
  if (!Number.isFinite(ifcX) || !Number.isFinite(ifcY)) return null;

  const worldMagnitude = Math.hypot(ifcX, ifcY);
  if (worldMagnitude < MIN_WORLD_MAGNITUDE_M) return null;

  const offsetMagnitude = Math.hypot(easting, northing);
  const residual = Math.hypot(ifcX - easting, ifcY - northing);
  const tolerance = Math.max(
    MIN_RESIDUAL_TOLERANCE_M,
    RESIDUAL_TOLERANCE_FRACTION * offsetMagnitude,
  );
  if (residual > tolerance) return null;

  // Where applying the conversion puts the model, versus where its geometry
  // already sits in the map CRS. Mirrors `computeProjectedCenter` exactly,
  // including the `?? 1 / ?? 0` axis defaults and the effective (not raw)
  // horizontal scale, so the reported error is the one the viewer renders.
  const abscissa = conversion.xAxisAbscissa ?? 1;
  const ordinate = conversion.xAxisOrdinate ?? 0;
  const scale = getEffectiveHorizontalScale(conversion.scale, mapScale, lengthUnitScale);
  const appliedE = easting + scale * (abscissa * ifcX - ordinate * ifcY);
  const appliedN = northing + scale * (ordinate * ifcX + abscissa * ifcY);

  const rotationIsIdentity = Math.abs(abscissa - 1) < 1e-9 && Math.abs(ordinate) < 1e-9;
  const placementCarriesRotation = Math.abs(coordinateInfo.buildingRotation ?? 0) > 1e-6;

  return {
    worldCenter: { x: ifcX, y: ifcY },
    offset: { easting, northing },
    residual,
    displacement: Math.hypot(appliedE - ifcX, appliedN - ifcY),
    rotationCorroborated: rotationIsIdentity || placementCarriesRotation,
  };
}

/**
 * The `IfcMapConversion` field values that make the conversion a horizontal
 * identity, i.e. "the geometry is already in the map CRS".
 *
 * `OrthogonalHeight` and `Scale` are deliberately absent. The fingerprint this
 * module matches is a duplicated HORIZONTAL offset and says nothing about the
 * vertical: zeroing an `OrthogonalHeight` that legitimately carries the site
 * altitude (while the geometry Z is local) would trade a horizontal error for a
 * vertical one. `Scale` is likewise left as authored — `getEffectiveHorizontalScale`
 * already resolves it, and overwriting it here would discard a genuine
 * foot/metre bridge.
 *
 * The axis pair IS included, and that is not symmetric with the two above. A
 * rotation is applied to the coordinates BEFORE the translation, so a
 * non-identity rotation acting on a map-sized world coordinate swings the model
 * by a distance of order ‖world‖ — millions of metres — no matter what the
 * offsets are. Leaving it while zeroing the offsets would move the model from
 * one wrong continent to another, so there is no "translation-only" fix to
 * offer. See {@link DoubleGeoreference.rotationCorroborated} for when that
 * reset merely restates the file and when it is our choice.
 */
export function identityConversionFields(): Array<{ field: string; value: number }> {
  return [
    { field: 'eastings', value: 0 },
    { field: 'northings', value: 0 },
    { field: 'xAxisAbscissa', value: 1 },
    { field: 'xAxisOrdinate', value: 0 },
  ];
}
