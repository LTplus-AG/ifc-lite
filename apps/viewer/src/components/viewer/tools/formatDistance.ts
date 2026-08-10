/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType } from '@ifc-lite/data';
import { ProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay, formatConverted } from '@/lib/units/display';

/**
 * Format a distance in meters to a human-readable string with appropriate units
 */
export function formatDistance(meters: number): string {
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
 * Format a distance honoring the user's LENGTHUNIT display override (#1573),
 * falling back to {@link formatDistance}'s auto-scaled metric when no
 * override is set for LENGTHUNIT.
 *
 * `meters` is always already SI: every distance the measure tool produces —
 * drag endpoints, axis deltas, picked-point offsets — is renderer/model
 * space, which is metres throughout (geometry is unit-scaled to metres at
 * import; see `measure-modes/coordinates.ts`). Display therefore resolves
 * against an EMPTY unit context, exactly like `MeasureQuantities`' totals:
 * handing it a file's declared millimetres would scale an already-metre
 * value a second time.
 */
export function formatDistanceDisplay(meters: number, overrides: Record<string, string>): string {
  const disp = resolveQuantityDisplay(meters, QuantityType.Length, ProjectUnits.empty(), overrides);
  if (disp.converted === null) return formatDistance(meters);
  const formatted = formatConverted(disp.converted);
  return disp.unit ? `${formatted} ${disp.unit}` : formatted;
}
