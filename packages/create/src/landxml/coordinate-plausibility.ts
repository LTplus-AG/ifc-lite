/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The northing/easting transposition check (§2.2, §9.1 of the mapping spec).
 *
 * LandXML `<P>`/`<CgPoint>` element text is *northing easting elevation*. A
 * producer that writes it easting-first is a real, observed defect, and it is
 * silent by construction: a transpose is a reflection, so the surface is still
 * well-formed, still renders, and passes every count-based assertion. It is
 * simply in the wrong place.
 *
 * This warns. It never refuses and never corrects:
 *
 * - A bounds test is a *plausibility* argument, not a proof. Refusing on it
 *   would block legitimate data at the edge of a zone.
 * - Auto-correcting would silently move a correct dataset, which is the same
 *   class of failure it is meant to catch, in the opposite direction.
 *
 * It also never infers from magnitude alone. Without declared bounds there is
 * no test — `checkCoordinateOrder` returns `null` and the caller says so.
 */

import type { LandXmlIfcWarning } from './result-types.js';

/** Inclusive metre bounds for a projected CRS's two horizontal axes. */
export interface CrsPlausibilityBounds {
  easting: readonly [number, number];
  northing: readonly [number, number];
}

/**
 * Bounds shared by every Transverse-Mercator-family projected CRS (UTM zones,
 * national TM grids such as SWEREF99 TM).
 *
 * The false easting is 500 000 m and a zone is ±500 km wide, so an easting
 * lives in roughly 0…1 000 000 m; a northing runs the length of the hemisphere,
 * to ~10 000 000 m. That asymmetry is the whole discriminating power of the
 * test, and it is a property of the projection family rather than of any one
 * EPSG code — which is why this needs no EPSG table and why §4.2's rule that
 * the exporter must not start resolving EPSG codes is not violated.
 *
 * Callers opt in by passing this; nothing here sniffs a CRS name for 'UTM'.
 */
export const TRANSVERSE_MERCATOR_BOUNDS: CrsPlausibilityBounds = {
  easting: [0, 1_000_000],
  northing: [0, 10_000_000],
};

function within(value: number, [low, high]: readonly [number, number]): boolean {
  return value >= low && value <= high;
}

/**
 * Test the coordinates as they are about to be written, in metres.
 *
 * Returns a warning only when the pair is implausible as written **and**
 * swapping the two axes would make it plausible. Both halves matter: the first
 * alone fires on any out-of-zone data, which is a different problem and not one
 * this check can diagnose; the second is what makes the message's claim — that
 * the source may be written easting-first — an inference the evidence supports.
 *
 * @param samples `(easting, northing)` metre pairs in the order they will be
 *   written to `IfcCartesianPointList3D`, i.e. already converted from LandXML's
 *   northing-first authored order.
 */
export function checkCoordinateOrder(
  samples: Iterable<readonly [number, number]>,
  bounds: CrsPlausibilityBounds,
  crsName: string,
): LandXmlIfcWarning | null {
  for (const [easting, northing] of samples) {
    if (!Number.isFinite(easting) || !Number.isFinite(northing)) continue;
    const plausibleAsWritten = within(easting, bounds.easting) && within(northing, bounds.northing);
    if (plausibleAsWritten) continue;
    const plausibleSwapped = within(northing, bounds.easting) && within(easting, bounds.northing);
    if (!plausibleSwapped) continue;

    return {
      code: 'LXIFC-COORD-ORDER',
      message:
        `Coordinate order looks transposed. Easting ${easting} is outside ${crsName}'s easting range `
        + `[${bounds.easting[0]}, ${bounds.easting[1]}], but would be a valid northing — and northing `
        + `${northing} would be a valid easting. LandXML point text is northing-first; a producer that `
        + 'writes it easting-first yields a mirrored surface that still renders and still passes every '
        + 'count check. Verify the source before relying on this export, or re-export it with the '
        + 'coordinate-order override if you know the producer is at fault.',
    };
  }
  return null;
}
