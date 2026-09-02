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

/**
 * Round a base-SI-scaled numeric value to 4 decimal places, same precision the
 * `Qto_` quantity path rounds to, so a measure property and a quantity that
 * describe the same physical value hash identically. Non-finite input (NaN,
 * Infinity — a malformed STEP value) passes through unrounded rather than
 * collapsing to 0, so it still hashes as the distinct, non-numeric-looking
 * value it is instead of silently matching every other malformed one.
 */
export function roundToScale(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}

/**
 * {@link scaleMeasureValue} followed by {@link roundToScale} — the exact
 * transform every model-diff fingerprint adapter (CLI, viewer, MCP) applies to
 * a measure-typed `IfcPropertySingleValue` before hashing it. Shared here so
 * the three adapters cannot drift the way three independent copies would.
 */
export function scaledPropertyValue(
  value: unknown,
  dataType: string | undefined,
  projectUnits: ProjectUnits,
): unknown {
  const scaled = scaleMeasureValue(value, dataType, projectUnits);
  return typeof scaled === 'number' ? roundToScale(scaled) : scaled;
}
