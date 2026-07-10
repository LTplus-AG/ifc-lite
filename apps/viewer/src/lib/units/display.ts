/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer-side helpers that map a property's raw IFC measure type (`dataType`)
 * or a quantity's `QuantityType` onto the file's declared display unit
 * (issue #1573).
 *
 * These are thin wrappers around `ProjectUnits` (the canonical resolver in
 * `@ifc-lite/parser`, mirrored in Rust at `rust/core/src/project_units/`) -
 * they never re-implement unit resolution, only adapt its result to what the
 * property/quantity cards need.
 *
 * `resolveMeasureDisplay` / `resolveQuantityDisplay` extend that with the
 * NON-DESTRUCTIVE display-unit converter (issue #1573 proposal 2): when the
 * user has picked an alternative unit for a unit-KIND (e.g.
 * VOLUMETRICFLOWRATEUNIT -> m³/h), values render CONVERTED into it. The
 * underlying model / mutation value is never touched, only the rendered
 * number and symbol change.
 */

import { QuantityType } from '@ifc-lite/data';
import { measureUnit, type ProjectUnits } from '@ifc-lite/parser';
import { alternativesForUnitType } from './alternatives.js';
import { convertValue, resolveFromUnit } from './convert.js';

/**
 * Resolve the display unit symbol for a property's raw IFC measure type
 * (e.g. "IFCVOLUMETRICFLOWRATEMEASURE"). Returns `null` when `dataType` is
 * absent, or when the measure is dimensionless / non-measure (labels,
 * ratios, counts, ...).
 */
export function formatMeasureUnit(dataType: string | undefined, projectUnits: ProjectUnits): string | null {
  return dataType ? (projectUnits.unitForMeasure(dataType)?.symbol ?? null) : null;
}

/** Maps a `QuantityType` (from `@ifc-lite/data`) to the unit-type token used
 *  to look up the file's declared unit, plus the SI default symbol to fall
 *  back to when the file declares nothing for that type. `null` for Count,
 *  which never has a unit. */
export const QUANTITY_TYPE_UNIT: Record<number, { unitType: string; defaultSymbol: string } | null> = {
  [QuantityType.Length]: { unitType: 'LENGTHUNIT', defaultSymbol: 'm' },
  [QuantityType.Area]: { unitType: 'AREAUNIT', defaultSymbol: 'm²' },
  [QuantityType.Volume]: { unitType: 'VOLUMEUNIT', defaultSymbol: 'm³' },
  [QuantityType.Count]: null,
  [QuantityType.Weight]: { unitType: 'MASSUNIT', defaultSymbol: 'kg' },
  [QuantityType.Time]: { unitType: 'TIMEUNIT', defaultSymbol: 's' },
};

/**
 * Resolve the display unit symbol for a quantity's `QuantityType`. Returns
 * `null` for Count (and any unrecognized type); otherwise prefers the file's
 * declared unit for that unit-type and falls back to the SI default symbol.
 */
export function formatQuantityUnit(quantityType: number, projectUnits: ProjectUnits): string | null {
  const entry = QUANTITY_TYPE_UNIT[quantityType];
  if (!entry) return null;
  return projectUnits.resolvedForUnitType(entry.unitType)?.symbol ?? entry.defaultSymbol;
}

/** Result of resolving a value's display: the unit symbol to render (the
 *  file's declared/default unit, or the user's override), and the value
 *  CONVERTED into it - `null` when no override applies (render the raw
 *  value as before) or the input wasn't a finite number. */
export interface UnitDisplay {
  unit: string | null;
  converted: number | null;
}

/**
 * Resolve a property's display value + unit, honoring a per-unit-type
 * display-unit override (issue #1573 proposal 2). Falls back to
 * {@link formatMeasureUnit}'s unconverted symbol (`converted: null`) when
 * `dataType` carries no measure semantics, the unit-type has no override, or
 * `value` isn't a finite number - callers keep rendering their existing
 * parsed display value in that case.
 */
export function resolveMeasureDisplay(
  value: unknown,
  dataType: string | undefined,
  projectUnits: ProjectUnits,
  overrides: Record<string, string>,
): UnitDisplay {
  const m = dataType ? measureUnit(dataType) : undefined;
  if (m?.kind === 'typed' && typeof value === 'number' && Number.isFinite(value)) {
    const optionId = overrides[m.unitType];
    const option = optionId ? alternativesForUnitType(m.unitType).find((o) => o.id === optionId) : undefined;
    if (option) {
      const fileUnit = projectUnits.unitForMeasure(dataType!) ?? { symbol: m.defaultSymbol, siScale: 1.0 };
      const from = resolveFromUnit(m.unitType, fileUnit);
      return { unit: option.symbol, converted: convertValue(value, from, option) };
    }
  }
  return { unit: formatMeasureUnit(dataType, projectUnits), converted: null };
}

/**
 * Resolve a quantity's display value + unit, honoring a per-unit-type
 * display-unit override (issue #1573 proposal 2). Mirrors
 * {@link resolveMeasureDisplay} for `QuantityType`-keyed values.
 */
export function resolveQuantityDisplay(
  value: number,
  quantityType: number,
  projectUnits: ProjectUnits,
  overrides: Record<string, string>,
): UnitDisplay {
  const entry = QUANTITY_TYPE_UNIT[quantityType];
  if (entry && Number.isFinite(value)) {
    const optionId = overrides[entry.unitType];
    const option = optionId ? alternativesForUnitType(entry.unitType).find((o) => o.id === optionId) : undefined;
    if (option) {
      const fileUnit = projectUnits.resolvedForUnitType(entry.unitType) ?? { symbol: entry.defaultSymbol, siScale: 1.0 };
      const from = resolveFromUnit(entry.unitType, fileUnit);
      return { unit: option.symbol, converted: convertValue(value, from, option) };
    }
  }
  return { unit: formatQuantityUnit(quantityType, projectUnits), converted: null };
}

/** Format a converted numeric value for display: locale-aware, capped at 4
 *  fraction digits (the values here are already unit-converted, so more
 *  precision would just be scale-factor noise). */
export function formatConverted(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
