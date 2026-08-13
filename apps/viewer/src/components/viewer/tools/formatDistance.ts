/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType } from '@ifc-lite/data';
import { ProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay, formatConverted } from '@/lib/units/display';

// Constructed once rather than per call: every measure-tool distance readout
// (including the live-drag SVG labels, which reformat on every pointer-move
// frame) resolves against this same empty context, so there is no reason to
// allocate a fresh one each time.
const EMPTY_UNITS = ProjectUnits.empty();

/** Auto-scaled metric string (mm / cm / m / km), the fallback used when no
 *  LENGTHUNIT override is set. */
function formatAutoScaledMetric(meters: number): string {
  if (meters < 0.01) {
    return `${(meters * 1000).toFixed(1)} mm`;
  } else if (meters < 1) {
    return `${(meters * 100).toFixed(1)} cm`;
  } else if (meters < 1000) {
    return `${meters.toFixed(3)} m`;
  } else {
    return `${(meters / 1000).toFixed(2)} km`;
  }
}

/**
 * Format a distance in meters to a human-readable string, honoring the
 * user's LENGTHUNIT display override (#1573) when one is set and falling
 * back to the auto-scaled metric (mm/cm/m/km) otherwise. `overrides`
 * defaults to `{}` so every pre-#2199 call site (which never knew about
 * unit overrides) keeps its exact prior behaviour unchanged.
 *
 * This is deliberately the ONE exported distance formatter — #2199 briefly
 * shipped a second, override-aware `formatDistanceDisplay` beside this
 * unconditionally-metric one, which left every measure-tool call site free
 * to pick either name and get a plausible-looking but wrong (unconverted)
 * result. Folding the override handling in here removes that choice instead
 * of guarding it.
 *
 * `meters` is always already SI: every distance the measure tool produces —
 * drag endpoints, axis deltas, picked-point offsets — is renderer/model
 * space, which is metres throughout (geometry is unit-scaled to metres at
 * import; see `measure-modes/coordinates.ts`). Display therefore resolves
 * against an EMPTY unit context, exactly like `MeasureQuantities`' totals:
 * handing it a file's declared millimetres would scale an already-metre
 * value a second time.
 */
export function formatDistance(meters: number, overrides: Record<string, string> = {}): string {
  const disp = resolveQuantityDisplay(meters, QuantityType.Length, EMPTY_UNITS, overrides);
  if (disp.converted === null) return formatAutoScaledMetric(meters);
  const formatted = formatConverted(disp.converted);
  return disp.unit ? `${formatted} ${disp.unit}` : formatted;
}

/**
 * A single length axis, converted the same way {@link formatDistance} does,
 * but WITHOUT the trailing unit symbol — the numeric half only. Used to build
 * a multi-axis triple that prints one shared unit instead of repeating it
 * per axis (see `formatSignedTriple` below).
 */
function formatDistanceMagnitude(meters: number, overrides: Record<string, string>): string {
  const disp = resolveQuantityDisplay(meters, QuantityType.Length, EMPTY_UNITS, overrides);
  return disp.converted === null ? meters.toFixed(3) : formatConverted(disp.converted);
}

/**
 * Format a signed X/Y/Z LENGTH-DELTA triple honoring the LENGTHUNIT display
 * override, e.g. `X 3.2808  Y 6.5617  Z 9.8425`.
 *
 * This is for a triple that IS a distance — the Measure tool's
 * relative-reference offset (dx/dy/dz from a user-set datum), the same kind
 * of signed length `formatAxisDeltas` already converts — not a raw model
 * coordinate. `formatCoordinateTriple` in `measure-modes/coordinates.ts`
 * stays in unlabelled metres for the Model / Render / Map rows, which are
 * point positions in a file's own coordinate system or a projected CRS, and
 * are deliberately out of #2199's scope.
 *
 * Deep review on #2538: before this, the "Rel. ref" row converted only its
 * trailing distance hint, leaving the triple beside it in unlabelled metres —
 * a `ft` override made the row read e.g. `X 1.000 Y 2.000 Z 3.000  12.2758
 * ft`, mixing units in one line. All three axes share one override, so the
 * unit is resolved once by the caller (from the accompanying
 * {@link formatDistance} hint) rather than printed three times here.
 */
export function formatSignedTriple(
  p: { x: number; y: number; z: number },
  overrides: Record<string, string> = {},
): string {
  const axis = (n: number) => formatDistanceMagnitude(n, overrides);
  return `X ${axis(p.x)}  Y ${axis(p.y)}  Z ${axis(p.z)}`;
}
