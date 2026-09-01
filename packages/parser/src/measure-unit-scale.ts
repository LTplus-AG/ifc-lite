/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ProjectUnits } from './project-units.js';

/**
 * Scale a property value to base SI, using the file's declared units.
 *
 * An `IfcPropertySingleValue` measure (`IfcLengthMeasure`, `IfcAreaMeasure`,
 * `IfcPositiveLengthMeasure`, …) is stored in the project's raw author unit —
 * exactly like an `IfcElementQuantity` (`Qto_`) quantity, which the IDS
 * property bridge and the model-diff quantity path both already scale before
 * comparing. Nothing scaled the property-value path: a wall re-exported from a
 * metre-authored file (`IfcLengthMeasure(2.5)`) into a millimetre-authored one
 * (`IfcLengthMeasure(2500.)`), with no edit to the design at all, hashed to two
 * different `dataHash` values in every model-diff adapter — the file was
 * misreported as `modified · data` on every quantified element.
 *
 * `dataType` is the on-demand extractor's IFC measure tag, read off the typed
 * STEP value itself (`parsePropertyValue`, `on-demand-extractors.ts`), so this
 * resolves for any project-scoped measure `ProjectUnits.unitForMeasure` knows —
 * length, area, volume, and the rest of the measure table — not only the three
 * the `Qto_` quantity path special-cases. A property whose declared type has no
 * project-scoped unit (a label, an identifier, a dimensionless ratio) resolves
 * no unit and passes through unscaled, same as a value with no `dataType` at
 * all — this function is a no-op for every property it should not touch.
 */
export function scaleMeasureValue(
  value: unknown,
  dataType: string | undefined,
  projectUnits: ProjectUnits,
): unknown {
  if (typeof value !== 'number' || !dataType) return value;
  const unit = projectUnits.unitForMeasure(dataType);
  return unit && unit.siScale !== 1 ? value * unit.siScale : value;
}
