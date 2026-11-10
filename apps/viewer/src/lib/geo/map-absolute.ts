/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model's position in the IFC world frame, and the detection of geometry
 * that is ALREADY in absolute map coordinates (issue #2526).
 */

import type { MapConversion } from '@ifc-lite/parser';
import { NORMAL_COORD_THRESHOLD_M, type CoordinateInfo } from '@ifc-lite/geometry';
import { ifcToViewerAxes, viewerToIfcAxes } from './coordinate-frame';
import { viewerFrameCenter } from './cesium-viewer-frame';

/**
 * Compute the model's center in IFC Z-up metres from coordinate info.
 * This is the geometry center before MapConversion is applied.
 */
export function computeModelCenterInIfcMeters(
  coordinateInfo?: CoordinateInfo,
): { ifcX: number; ifcY: number; ifcZ: number } {
  if (!coordinateInfo) return { ifcX: 0, ifcY: 0, ifcZ: 0 };

  // The renderer-frame pivot (from `shiftedBounds`, NOT `originalBounds`:
  // `originalBounds` is ALREADY in the world frame, so adding the shift to it
  // would count it twice) plus the render-frame offset. This is reproject.ts's
  // `world_yup = bounds_center + originShift`, and the same pivot the camera
  // and model matrix use, including its stray-element fallback.
  // Summed centre + shift first, then RTC: the shift can cancel the centre
  // exactly, and adding it to the RTC first would lose small RTC digits.
  const center = viewerFrameCenter(coordinateInfo);
  const shift = coordinateInfo.originShift;
  const rtcYup = ifcToViewerAxes(coordinateInfo.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });
  const worldIfc = viewerToIfcAxes({
    x: center.x + shift.x + rtcYup.x,
    y: center.y + shift.y + rtcYup.y,
    z: center.z + shift.z + rtcYup.z,
  });
  return { ifcX: worldIfc.x, ifcY: worldIfc.y, ifcZ: worldIfc.z };
}

/**
 * The declared anchor must sit at real projected-CRS magnitude before the
 * map-absolute detection may fire. Compliant zero-ish offsets (site grids a
 * few km out) stay below this, so a small legitimate offset + rotation is
 * never silently dropped. Real projected CRS coordinates (UTM, national
 * grids) start in the hundreds of km.
 */
const MAP_ABSOLUTE_MIN_ANCHOR_METERS = 100_000;
/**
 * How close (metres) the geometry centre must be to the declared anchor to
 * count as "already sitting at it". This IS the wasm RTC re-base threshold
 * (10 km), not a separate number that happens to equal it: a compliant file's
 * geometry lives near the LOCAL origin because the re-base put it there, so
 * its centre is `anchorDistance` (>100 km) away from the anchor and stays
 * outside this radius. (A file that intentionally draws its local geometry
 * right at the anchor's magnitude AND means the conversion to apply on top
 * would be misread — that coincidence is treated as the absolute-placement
 * signature.)
 *
 * Until #4611 this was its own `10_000` literal, with the agreement stated in
 * the sentence above and nothing enforcing it; moving the re-base threshold
 * would have left this radius behind. `map-absolute.test.ts` derives its
 * boundary cases from the imported constant, so the two cannot part again.
 */
const MAP_ABSOLUTE_MAX_CENTER_DISTANCE_METERS = NORMAL_COORD_THRESHOLD_M;

/**
 * Detect geometry that is ALREADY in absolute map coordinates and neutralise
 * the IfcMapConversion for it (issue #2526).
 *
 * Vectorworks exports place the IfcSite at the absolute projected coordinates
 * (in project units) AND write an IfcMapConversion whose Eastings/Northings
 * repeat the same anchor (in map units), often with a rotation. Applying that
 * conversion on top of the absolute geometry double-transforms: the #2526
 * EPSG:25833 file (Rostock, E 311 988 / N 5 996 149) landed in the mid
 * Atlantic because its 90-degree XAxis rotation turned the ~6 000 km northing
 * into a huge negative easting.
 *
 * Signature checked: the declared map anchor is at projected-CRS magnitude
 * (>100 km from the local origin) AND the model centre — with the RTC/origin
 * shifts folded back in — sits within RTC-threshold reach (10 km) of that
 * anchor. A compliant file keeps its geometry near the LOCAL origin, so its
 * centre is the full anchor distance away and the detection cannot fire.
 *
 * A second signature covers the same export with the site anchor written in
 * map units instead of project units (#9480, see {@link MapAbsoluteMatch}).
 * There the offsets become the part of the anchor the geometry does NOT
 * carry, `Eastings x (1 - ratio)`; everything else is reset as below.
 *
 * When detected, the returned conversion carries zero offsets, the
 * no-rotation axis, AND unit scale (1) so every consumer of the standard
 * formula `E = Eastings*mapScale + s*(a*x - o*y)` reads the geometry's
 * absolute coordinates through completely unchanged — `s` must be 1, not
 * merely authored-and-left-alone: with eastings=0 and axis=(1,0) the formula
 * reduces to `E = s*x`, so an authored non-unity `Scale` (e.g. a UTM point
 * scale factor like 0.9996, or a spec unit-bridging value) would still
 * multiply the model's FULL absolute coordinate — the offset this detection
 * exists to zero, not the small local delta `Scale` is meant to condition.
 * `orthogonalHeight` stays authored: the
 * #2526 file carries the absolute elevation in the placement (folded into
 * the geometry's Z) and 0 in OrthogonalHeight, so keeping it is correct
 * there; a map-absolute file that ALSO wrote a non-zero OrthogonalHeight
 * would double-count height — the detection reads only the horizontal
 * signature and cannot tell. The one exception is #9480 with a published
 * `coordinateInfo.siteOrigin`: its height is raised by the slipped part of
 * the site's Z (see {@link MapAbsoluteMatch}). The authored entity values are NOT modified —
 * panels and exports still see the file's data.
 */
export function effectiveMapConversionForGeometry(
  conversion: MapConversion,
  mapUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): MapConversion {
  const match = matchMapAbsoluteGeometry(conversion, mapUnitScale, coordinateInfo);
  if (!match) return conversion;
  // The anchor the geometry already carries, in map units: the whole offset
  // for the #2526 signature, the mis-scaled site anchor for #9480. Moving the
  // geometry by the rest puts that anchor on the declared one.
  const carried = match.kind === 'unitMismatchedAnchor' ? match.anchorUnitRatio : 1;
  const heightShift = match.kind === 'unitMismatchedAnchor' ? match.siteHeightShiftMetres ?? 0 : 0;
  return {
    ...conversion,
    eastings: conversion.eastings * (1 - carried),
    orthogonalHeight: conversion.orthogonalHeight + heightShift / mapUnitScale,
    northings: conversion.northings * (1 - carried),
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
    // Clear the subtype factors as well: an authored factor would rescale the
    // already-absolute coordinates exactly as an authored Scale would.
    factorX: undefined,
    factorY: undefined,
    factorZ: undefined,
  };
}

/**
 * How the geometry carries the declared map anchor, when it does:
 *
 * - `anchor` (#2526): the IfcSite sits AT the anchor, in project units.
 * - `unitMismatchedAnchor` (#9480): the IfcSite placement repeats the
 *   Eastings/Northings NUMBERS in map units inside a file whose length unit
 *   differs (Vectorworks 2026 Update 7 writes `311988.18` into a millimetre
 *   file where Update 5 wrote `311988180.54`). Read in project units the site
 *   sits at `anchor x anchorUnitRatio`, where the ratio is
 *   `lengthUnitScale / mapUnitScale` (0.001 for a millimetre file in a metre
 *   CRS) — kilometres from the map origin, so the conversion applied on top
 *   lands the model that same distance off and turned by its rotation. The
 *   placement's height carries the same slip (14 instead of 14000). The
 *   geometry bounds cannot tell it from the building's own Z, so it is
 *   recovered only from the pre-pass `coordinateInfo.siteOrigin`, and only
 *   when that origin sits at the mis-scaled anchor: `siteHeightShiftMetres`
 *   is then `siteZ x (1/ratio - 1)`, else undefined (height left authored).
 */
export type MapAbsoluteMatch =
  | { kind: 'anchor' }
  | { kind: 'unitMismatchedAnchor'; anchorUnitRatio: number; siteHeightShiftMetres?: number };

/**
 * The #9480 radius, relative to the mis-scaled anchor's own distance from the
 * local origin. That distance is only `anchor x ratio` (about 6 km for a UTM
 * northing in a millimetre file, 100 m at the 100 km floor), so the absolute
 * 10 km radius would also take a compliant model drawn near the local origin.
 * A tenth keeps every such model out — its centre is the whole distance away —
 * while leaving a building hundreds of metres across around its site origin in.
 */
const UNIT_MISMATCH_RELATIVE_RADIUS = 0.1;

/**
 * A unit ratio this close to 1 is the plain #2526 signature, not a unit
 * mismatch; real mismatches are powers of ten or a foot (0.3048).
 */
function isDistinctUnitRatio(ratio: number): boolean {
  return Number.isFinite(ratio) && ratio > 0 && (ratio <= 0.5 || ratio >= 2);
}

/**
 * Which map-absolute signature, if any, the geometry matches. The one
 * predicate behind {@link effectiveMapConversionForGeometry},
 * {@link isMapAbsoluteGeometry} and the double-georeference report.
 */
export function matchMapAbsoluteGeometry(
  conversion: Pick<MapConversion, 'eastings' | 'northings'>,
  mapUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): MapAbsoluteMatch | null {
  if (!coordinateInfo) return null;
  const anchorE = conversion.eastings * mapUnitScale;
  const anchorN = conversion.northings * mapUnitScale;
  const anchorDistance = Math.hypot(anchorE, anchorN);
  if (!Number.isFinite(anchorDistance) || anchorDistance < MAP_ABSOLUTE_MIN_ANCHOR_METERS) return null;
  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);
  const centerDistance = Math.hypot(ifcX - anchorE, ifcY - anchorN);
  if (Number.isFinite(centerDistance) && centerDistance < MAP_ABSOLUTE_MAX_CENTER_DISTANCE_METERS) {
    return { kind: 'anchor' };
  }

  // #9480: the same anchor, read in the wrong unit. Only a file that states
  // both units can say so; without the project length unit there is no ratio.
  const lengthUnitScale = coordinateInfo.lengthUnitScale;
  if (lengthUnitScale === undefined || !(mapUnitScale > 0)) return null;
  const ratio = lengthUnitScale / mapUnitScale;
  if (!isDistinctUnitRatio(ratio)) return null;
  const misE = anchorE * ratio;
  const misN = anchorN * ratio;
  const radius = Math.min(
    MAP_ABSOLUTE_MAX_CENTER_DISTANCE_METERS,
    UNIT_MISMATCH_RELATIVE_RADIUS * anchorDistance * ratio,
  );
  const misDistance = Math.hypot(ifcX - misE, ifcY - misN);
  if (!(Number.isFinite(misDistance) && misDistance < radius)) return null;
  // The site's own Z carries the slip only if the site IS the slipped anchor.
  const site = coordinateInfo.siteOrigin;
  const siteIsAnchor = site !== undefined && Number.isFinite(site.z)
    && Math.hypot(site.x - misE, site.y - misN) < radius;
  return siteIsAnchor
    ? { kind: 'unitMismatchedAnchor', anchorUnitRatio: ratio, siteHeightShiftMetres: site.z * (1 / ratio - 1) }
    : { kind: 'unitMismatchedAnchor', anchorUnitRatio: ratio };
}

/**
 * The signatures {@link effectiveMapConversionForGeometry} neutralises on:
 * the geometry already sits at absolute map (grid) coordinates, up to the
 * #9480 unit slip in the site anchor. Exposed on its own because such
 * geometry is drawn in GRID lengths, which the globe placement must scale to
 * ground lengths (`ground-scale.ts`).
 */
export function isMapAbsoluteGeometry(
  conversion: Pick<MapConversion, 'eastings' | 'northings'>,
  mapUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): boolean {
  return matchMapAbsoluteGeometry(conversion, mapUnitScale, coordinateInfo) !== null;
}
