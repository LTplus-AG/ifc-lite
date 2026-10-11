/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which SI conversion an IFC measure value takes (#7395). IDS 1.0 compares
 * every measure in SI units, so a value stored in a project or own unit has
 * to be brought into the SI base of its measure: metre, radian, kelvin,
 * kilogram, second, newton, watt, and the derived units composed of them.
 *
 * Length, area and volume keep their dedicated resolution in `units.ts`
 * (`store.lengthUnitScale`, which prefers the named conversion table, and the
 * squared/cubed fallback); every other dimensioned measure reads the unit the
 * project declares for its unit type, through the parser's canonical
 * measure-to-unit-type table (`measureUnit`). Dimensionless and monetary
 * measures are not SI quantities and never move.
 */

import { measureUnit, type ProjectUnits } from '@ifc-lite/parser';

/** `si = raw * scale + offset`. The offset is non-zero only for Celsius. */
export interface SiConversion {
  scale: number;
  offset: number;
}

/** 0 °C in kelvin. */
const CELSIUS_OFFSET_K = 273.15;

/** The measures `units.ts` resolves from the project's length unit. */
export type LengthFamilyKind = 'length' | 'area' | 'volume';

export function lengthFamilyKind(dataType: string | undefined): LengthFamilyKind | undefined {
  const upper = dataType ? dataType.toUpperCase() : '';
  if (
    upper === 'IFCLENGTHMEASURE' ||
    upper === 'IFCPOSITIVELENGTHMEASURE' ||
    upper === 'IFCNONNEGATIVELENGTHMEASURE'
  ) {
    return 'length';
  }
  if (upper === 'IFCAREAMEASURE') return 'area';
  if (upper === 'IFCVOLUMEMEASURE') return 'volume';
  return undefined;
}

function isTemperature(dataType: string): boolean {
  return dataType.toUpperCase() === 'IFCTHERMODYNAMICTEMPERATUREMEASURE';
}

/**
 * The conversion for a value in a unit with SI factor `siScale` and display
 * `symbol`. A temperature is only convertible from kelvin or Celsius: any
 * other temperature unit (Fahrenheit, Rankine) needs an offset IFC carries
 * only on `IfcConversionBasedUnitWithOffset`, which is not resolved, so it
 * stays as written rather than being scaled without its offset.
 */
export function unitConversion(
  dataType: string,
  siScale: number | undefined,
  symbol: string | undefined
): SiConversion | undefined {
  if (siScale === undefined || !Number.isFinite(siScale) || siScale <= 0) return undefined;
  if (!isTemperature(dataType)) return { scale: siScale, offset: 0 };
  if (symbol === 'K') return { scale: siScale, offset: 0 };
  if (symbol === '°C') return { scale: siScale, offset: CELSIUS_OFFSET_K };
  return undefined;
}

/**
 * The project-unit conversion for a dimensioned measure outside the length
 * family, or `undefined` when the measure is dimensionless, monetary, has no
 * declared unit (SI is then implied), or its declared unit could not be read.
 * `fallbackUnits` answers only for a unit type `units` leaves undeclared.
 */
export function projectUnitConversion(
  dataType: string | undefined,
  units: ProjectUnits | undefined,
  fallbackUnits?: ProjectUnits
): SiConversion | undefined {
  if (!dataType || (!units && !fallbackUnits) || lengthFamilyKind(dataType)) return undefined;
  const m = measureUnit(dataType);
  if (!m || m.kind !== 'typed') return undefined;
  // A unit the owner declares but could not resolve (`unitForMeasure` null)
  // stays unconverted: the file-wide unit answers only an undeclared type.
  const own = units?.resolvedForUnitType(m.unitType);
  const ownUnresolved = !own && units?.unitForMeasure(dataType) === null;
  const declared = own ?? (ownUnresolved ? undefined : fallbackUnits?.resolvedForUnitType(m.unitType));
  if (!declared) return undefined;
  return unitConversion(dataType, declared.siScale, declared.symbol);
}

export function isIdentity(c: SiConversion | undefined): boolean {
  return !c || (c.scale === 1 && c.offset === 0);
}

export function toSi(raw: number, c: SiConversion): number {
  return raw * c.scale + c.offset;
}

export function fromSi(si: number, c: SiConversion): number {
  return (si - c.offset) / c.scale;
}

/** Convert a numeric value or numeric string; `null` when it is not a finite number. */
export function convertNumeric(v: unknown, c: SiConversion): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? toSi(n, c) : null;
}

/**
 * Convert the members of a list or table whose members carry their own types
 * (`valueDataTypes`, index-aligned with `values`), each by the conversion
 * `conversionFor` gives its type. An untyped or non-measure member stays as
 * written.
 */
export function convertTypedMembers(
  values: string[],
  valueDataTypes: ReadonlyArray<string | undefined>,
  conversionFor: (dataType: string | undefined) => SiConversion | undefined
): string[] {
  return values.map((v, i) => {
    const c = conversionFor(valueDataTypes[i]);
    if (isIdentity(c)) return String(v);
    const converted = convertNumeric(v, c!);
    return converted == null ? String(v) : String(converted);
  });
}
