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

/**
 * Compute the model's center in IFC Z-up metres from coordinate info.
 * This is the geometry center before MapConversion is applied.
 */
export function computeModelCenterInIfcMeters(
  coordinateInfo?: CoordinateInfo,
): { ifcX: number; ifcY: number; ifcZ: number } {
  if (!coordinateInfo) return { ifcX: 0, ifcY: 0, ifcZ: 0 };

  // `shiftedBounds`, NOT `originalBounds`. The producer defines
  // `shiftedBounds = originalBounds - originShift`
  // (utils/localParsingUtils.ts), so `originalBounds` is ALREADY in the world
  // frame — adding `shift` to it below would count the shift twice and put the
  // model centre `originShift` away from where the footprint polygon
  // (computeFootprintGeoJSON, which reads `shiftedBounds`) places the very same
  // box. This matches the rule stated in reproject.ts's pipeline doc:
  // `world_yup = bounds_center + originShift`, from the VIEWER bounds.
  const bounds = coordinateInfo.shiftedBounds;
  const shift = coordinateInfo.originShift;
  const rtcYup = ifcToViewerAxes(coordinateInfo.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });

  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;

  const worldYup = {
    x: cx + shift.x + rtcYup.x,
    y: cy + shift.y + rtcYup.y,
    z: cz + shift.z + rtcYup.z,
  };
  const worldIfc = viewerToIfcAxes(worldYup);
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
 * signature and cannot tell. The authored entity values are NOT modified —
 * panels and exports still see the file's data.
 */
export function effectiveMapConversionForGeometry(
  conversion: MapConversion,
  mapUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
): MapConversion {
  if (!coordinateInfo) return conversion;
  const anchorE = conversion.eastings * mapUnitScale;
  const anchorN = conversion.northings * mapUnitScale;
  const anchorDistance = Math.hypot(anchorE, anchorN);
  if (!Number.isFinite(anchorDistance) || anchorDistance < MAP_ABSOLUTE_MIN_ANCHOR_METERS) {
    return conversion;
  }
  const { ifcX, ifcY } = computeModelCenterInIfcMeters(coordinateInfo);
  const centerDistance = Math.hypot(ifcX - anchorE, ifcY - anchorN);
  if (!Number.isFinite(centerDistance) || centerDistance >= MAP_ABSOLUTE_MAX_CENTER_DISTANCE_METERS) {
    return conversion;
  }
  return {
    ...conversion,
    eastings: 0,
    northings: 0,
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
