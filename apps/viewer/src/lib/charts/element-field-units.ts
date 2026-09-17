/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit semantics of an IFC field cell in the elements chart dataset (#4833).
 *
 * A number is summable only in ONE unit for the whole column. Each cell is
 * therefore converted into the column's target unit from the unit it is
 * actually in — the property's own explicit `Unit` when it declares one, else
 * the model's project assignment — and a cell whose unit cannot be
 * established is `unsupported`, never guessed:
 *
 * - a typed measure with no project unit and no explicit unit (the file
 *   declared nothing to convert from);
 * - an explicit unit the parser could not resolve (`#123`, no scale);
 * - a monetary value whose currency differs from the column's, or is unknown
 *   (there is no exchange rate to convert a euro into a dollar);
 * - a declared measure incompatible with the binding's (a length in an area
 *   column).
 *
 * Categories are unit-qualified instead (`1 mm` and `1 m` are different
 * labels), so a mixed-unit federation can still be grouped honestly.
 */
import type { ElementFieldBinding, NormalizedElementFieldValue } from '@ifc-lite/charts';
import { measureUnit, type MeasureUnit, type ProjectUnits } from '@ifc-lite/parser';
import type { ListColumnUnitResolver } from '@/lib/units/list-column-units';
import { sourceUnitSymbolForMeasure } from '@/lib/units/list-column-units';
import { alternativesForUnitType } from '@/lib/units/alternatives';
import { convertValue, type LinearUnit } from '@/lib/units/convert';
import type { ResolvedElementFieldValue } from './element-field-reader';

const UNSUPPORTED: NormalizedElementFieldValue = { value: null, status: 'unsupported' };

/** Whether a model declares (or derives from its length unit) a source unit for `unitType`. */
export function hasSourceUnit(units: ProjectUnits | undefined, unitType: string): boolean {
  if (!units) return false;
  if (units.resolvedForUnitType(unitType)) return true;
  return (unitType === 'AREAUNIT' || unitType === 'VOLUMEUNIT') && Boolean(units.resolvedForUnitType('LENGTHUNIT'));
}

/** The one display unit a numeric field's column is summed in, or `undefined` when none can be established. */
export function resolveFieldColumnUnit(
  field: ElementFieldBinding,
  index: number,
  modelUnits: ReadonlyMap<string, ProjectUnits>,
  resolver: ListColumnUnitResolver,
): string | undefined {
  const measure = field.dataType ? measureUnit(field.dataType) : undefined;
  if (measure?.kind === 'monetary') {
    if (field.unit) return field.unit;
    for (const units of modelUnits.values()) {
      const currency = units.monetary()?.symbol;
      if (currency) return currency;
    }
    return undefined;
  }
  if (measure?.kind !== 'typed') return field.unit;
  // The column's target: an override, else the first model's declared unit,
  // else the SI default. A model that declares no unit for this measure has
  // its project-unit rows refused per row (`hasSourceUnit`); rows carrying
  // their own explicit unit still convert into the target, so a federation of
  // explicit `Pa` and `kPa` values with no project PRESSUREUNIT sums in `Pa`.
  return resolver.unitSymbol(index) ?? field.unit;
}

/** A source unit for an explicit symbol: its parsed scale, or a curated alternative's when only the symbol is known. */
function explicitSourceUnit(unitType: string, symbol: string, siScale: number | undefined): LinearUnit | undefined {
  const curated = alternativesForUnitType(unitType).find((option) => option.symbol === symbol);
  if (siScale !== undefined) return { scale: siScale, offset: curated?.offset ?? 0 };
  return curated ? { scale: curated.scale, offset: curated.offset ?? 0 } : undefined;
}

function measureKind(dataType: string | undefined): MeasureUnit | undefined {
  return dataType ? measureUnit(dataType) : undefined;
}

export interface FieldCellContext {
  field: ElementFieldBinding;
  /** The field's index in the dataset's field list — the resolver's column index. */
  index: number;
  /** The column's resolved display unit (see {@link resolveFieldColumnUnit}). */
  columnUnit: string | undefined;
  modelId: string;
  projectUnits: ProjectUnits | undefined;
  resolver: ListColumnUnitResolver;
}

/** Convert one read into the column's unit, or say why it cannot be. */
export function resolveFieldCell(cell: ResolvedElementFieldValue, context: FieldCellContext): NormalizedElementFieldValue {
  if (cell.status !== 'value') return cell;
  const { field, index, columnUnit, modelId, projectUnits, resolver } = context;
  const declaredType = cell.dataType?.toUpperCase();
  const bindingType = field.dataType?.toUpperCase();
  const declared = measureKind(declaredType);
  const bound = measureKind(bindingType);
  const unitBearing = (measure: MeasureUnit | undefined): boolean => measure?.kind === 'typed' || measure?.kind === 'monetary';

  if (field.valueKind === 'number' && !bindingType && unitBearing(declared)) return UNSUPPORTED;
  if (bindingType && declaredType && bindingType !== declaredType
    && !(declared?.kind === 'typed' && bound?.kind === 'typed' && declared.unitType === bound.unitType)
    && !(declared?.kind === 'monetary' && bound?.kind === 'monetary')) {
    return UNSUPPORTED;
  }

  if (field.valueKind === 'category') {
    const sourceSymbol = projectUnits && declaredType ? sourceUnitSymbolForMeasure(projectUnits, declaredType) : undefined;
    const suffix = cell.unit
      ?? sourceSymbol
      ?? (declared?.kind === 'monetary' ? projectUnits?.monetary()?.symbol : undefined)
      ?? (declared?.kind === 'typed' ? cell.dataType : undefined);
    return { value: suffix ? `${cell.value} ${suffix}` : cell.value, status: 'value' };
  }
  if (typeof cell.value !== 'number') return { value: cell.value, status: cell.status };

  // An untagged number (`1.` with no IFC measure) carries no evidence of being
  // the binding's measure; without its own unit it cannot join a typed sum.
  if (!declared && unitBearing(bound) && cell.unit === undefined) return UNSUPPORTED;
  const kind = unitBearing(declared) ? declared : unitBearing(bound) ? bound : undefined;
  if (kind?.kind === 'monetary') {
    const currency = cell.unit ?? projectUnits?.monetary()?.symbol;
    return currency && columnUnit && currency === columnUnit ? { value: cell.value, status: 'value' } : UNSUPPORTED;
  }
  if (kind?.kind !== 'typed') {
    // A dimensionless or untyped number with its OWN unit (an `IfcReal` in
    // `mm`) cannot be converted into anything; only a unit equal to the
    // column's passes through unchanged.
    if (cell.unit !== undefined && cell.unit !== columnUnit) return UNSUPPORTED;
    return { value: cell.value, status: 'value' };
  }

  const target = resolver.targetUnit(index);
  if (!columnUnit || !target) return UNSUPPORTED;
  if (cell.unit !== undefined || cell.unitSiScale !== undefined) {
    // A quantity's explicit Unit arrives as a scale alone; a property's as symbol plus scale.
    const source = explicitSourceUnit(kind.unitType, cell.unit ?? '', cell.unitSiScale);
    return source ? { value: convertValue(cell.value, source, target), status: 'value' } : UNSUPPORTED;
  }
  if (!hasSourceUnit(projectUnits, kind.unitType)) return UNSUPPORTED;
  return { value: resolver.convertCell(index, cell.value, modelId), status: 'value' };
}
