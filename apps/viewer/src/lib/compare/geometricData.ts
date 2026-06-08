/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single boundary between **data** and **geometry** for model compare
 * (issue #924).
 *
 * A change to where/how an element sits in space — placement, coordinates,
 * elevation, level offsets — is a *geometry* change, fully captured by the
 * per-entity geometry hash (world-space mesh). It must NOT also flip the data
 * fingerprint, or a pure move reads as "data · geometry" instead of geometry
 * only. Authoring tools leak placement into property sets (Revit's "Elevation",
 * "Height Offset From Level", "Base/Top Offset", level references), so we filter
 * those out of the data side by name.
 *
 * Used by both `buildFingerprints` (so the data hash ignores them) and
 * `describeChange` (so the "what changed" panel doesn't list them as data).
 * Quantities (Volume/Area/Length/…) are excluded wholesale at the call site —
 * they are geometry-derived measurements, not in scope here.
 */

// Deliberately narrow: only names that are *specifically* placement (elevation,
// (object)placement, coordinate) or a qualified level/axis offset. Generic
// `Location` / `Position` / `Datum` / bare `Offset` are NOT excluded — they are
// just as often ordinary semantic data (a custom "Location" string, a "Position"
// label), and wrongly dropping them from the data diff would hide real edits.
const GEOMETRIC_NAME =
  /elevation|placement|coordinate|reference\s*level|(height|base|top|bottom|level|z)\s*offset/i;

/**
 * True when an attribute / property / property-set name denotes geometric
 * placement data that belongs to the geometry diff, not the data diff.
 */
export function isGeometricDataName(name: string): boolean {
  return GEOMETRIC_NAME.test(name);
}
