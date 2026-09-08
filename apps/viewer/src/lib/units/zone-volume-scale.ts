/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProjectUnits } from '@ifc-lite/parser';

/**
 * The SI scale of a model's volume unit, for the zone volume columns (#2508).
 *
 * This MUST agree with `sourceUnitFor`'s VOLUMEUNIT branch in
 * `list-column-units.ts`: the adapter divides a cubic-metre mesh volume by this
 * scale to produce the stored "home" value, and the column resolver then reads
 * that value back through its own source unit. When the two disagree the cell is
 * wrong by exactly the difference.
 *
 * A file that declares no VOLUMEUNIT means "derive it from LENGTHUNIT", cubed.
 * Returning 1 there -- as this did before -- left the adapter's value in m3
 * while the resolver read it as LENGTHUNIT3, so a 30 m3 zone in a millimetre
 * model displayed as 3e-8 m3.
 *
 * `zoneFacts.ts`'s `volumeScaleOf` has the same shape and feeds IFC write-back
 * rather than display; it is not changed here.
 */
export function zoneVolumeSiScale(pu: ProjectUnits): number {
  const declared = pu.resolvedForUnitType('VOLUMEUNIT')?.siScale;
  if (declared !== undefined) return declared;
  return (pu.unitForMeasure('IfcLengthMeasure')?.siScale ?? 1) ** 3;
}
