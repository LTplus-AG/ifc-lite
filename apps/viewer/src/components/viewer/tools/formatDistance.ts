/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format a distance in meters to a human-readable string with appropriate units.
 * Honors per-unit-type display-unit overrides (issue #1573 proposal 2).
 *
 * @param meters - Distance in metres (SI base)
 * @param projectUnits - File's declared units; defaults to ProjectUnits.empty()
 * @param unitDisplayOverrides - Map of unit-type tokens to override option IDs
 */

import { QuantityType } from '@ifc-lite/data';
import { ProjectUnits, type ProjectUnits as IProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay, formatConverted } from '@/lib/units/display';

export function formatDistance(
  meters: number,
  projectUnits?: IProjectUnits,
  unitDisplayOverrides?: Record<string, string>,
): string {
  const units = projectUnits ?? ProjectUnits.empty();
  const overrides = unitDisplayOverrides ?? {};

  // Try to resolve the display with quantity conversion
  const disp = resolveQuantityDisplay(meters, QuantityType.Length, units, overrides);

  // If there's a converted value (override was applied), use it with the override unit
  if (disp.converted !== null && disp.unit) {
    return `${formatConverted(disp.converted)} ${disp.unit}`;
  }

  // Otherwise, fall back to the default smart unit selection
  // This maintains backward compatibility for the no-override case
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
