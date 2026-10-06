/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Typed cell values for table corrections (P15). A cell is parsed with the
 * shared table parser (`parseValue`, the same one CSV import and the Flow
 * table nodes use), so `12,5` or `N/A` in a numeric column is refused rather
 * than written. A declared unit converts the cell to SI and then into the
 * frame the model stores (its project units, or the property's own explicit
 * unit) through the same resolver IDS validation uses. Without a unit a
 * number is taken to be in the model's stored units already.
 */

import { PropertyValueType, QuantityType, type Property, type Quantity } from '@ifc-lite/data';
import { validatePropertyDataType } from '@ifc-lite/export';
import { resolveEntityMeasureScales, toRaw } from '@ifc-lite/ids/bridge';
import { parseValue, PARSE_INVALID } from '@ifc-lite/mutations';
import type { ModelReader } from './model-change-values';
import { TABLE_UNITS, type ColumnValueType, type MeasureKind, type TableUnit } from './table-mapping';

export type CellOutcome =
  | { ok: true; value: string | number | boolean; dataType?: string }
  | { ok: false; kind: 'invalid-value' | 'unit-mismatch'; detail: string };

const PARSE_TYPE: Record<ColumnValueType, PropertyValueType> = {
  text: PropertyValueType.String, real: PropertyValueType.Real, integer: PropertyValueType.Integer, boolean: PropertyValueType.Boolean,
};
const BASE_TYPE: Record<ColumnValueType, string> = { text: 'IfcLabel', real: 'IfcReal', integer: 'IfcInteger', boolean: 'IfcBoolean' };
const TEXT_TYPES = new Map([[PropertyValueType.Label, 'IfcLabel'], [PropertyValueType.Text, 'IfcText'], [PropertyValueType.Identifier, 'IfcIdentifier']]);
const MEASURE_TYPE: Record<MeasureKind, string> = { length: 'IfcLengthMeasure', area: 'IfcAreaMeasure', volume: 'IfcVolumeMeasure' };
const QUANTITY_KIND = new Map<QuantityType, MeasureKind>([[QuantityType.Length, 'length'], [QuantityType.Area, 'area'], [QuantityType.Volume, 'volume']]);

export function measureKindOf(dataType: string | undefined): MeasureKind | undefined {
  const upper = dataType?.toUpperCase();
  if (upper === 'IFCLENGTHMEASURE' || upper === 'IFCPOSITIVELENGTHMEASURE') return 'length';
  if (upper === 'IFCAREAMEASURE') return 'area';
  if (upper === 'IFCVOLUMEMEASURE') return 'volume';
  return undefined;
}

/** The property as the model holds it now (pending edits included), or undefined. */
export function existingProperty(reader: ModelReader, expressId: number, pset: string, name: string): Property | undefined {
  for (const set of reader.view.getForEntity(expressId)) {
    if (set.name !== pset) continue;
    const found = set.properties.find((property) => property.name === name);
    if (found) return found;
  }
  return undefined;
}

export function existingQuantity(reader: ModelReader, expressId: number, qset: string, name: string): Quantity | undefined {
  return reader.view.getQuantitiesForEntity(expressId).find((set) => set.name === qset)?.quantities.find((q) => q.name === name);
}

function parseCell(cell: string, valueType: ColumnValueType): string | number | boolean | null {
  const value = parseValue(cell, PARSE_TYPE[valueType]);
  if (value === PARSE_INVALID || value === null || Array.isArray(value)) return null;
  return value as string | number | boolean;
}

/** Table value in `unit` → SI → the frame `dataType` is stored in for this element. */
function toStored(reader: ModelReader, expressId: number, value: number, unit: TableUnit, dataType: string, ownScale?: number): number {
  const si = value * TABLE_UNITS[unit].si;
  if (ownScale) return si / ownScale;
  const raw = toRaw(si, dataType, resolveEntityMeasureScales(reader.dataStore, expressId));
  return typeof raw === 'number' ? raw : si;
}

export function propertyCell(reader: ModelReader, expressId: number, pset: string, name: string, cell: string,
  valueType: ColumnValueType, unit?: TableUnit): CellOutcome {
  let value = parseCell(cell, valueType);
  if (value === null) return { ok: false, kind: 'invalid-value', detail: `"${cell}" is not ${valueType}` };
  const existing = existingProperty(reader, expressId, pset, name);
  let dataType = existing?.dataType ?? (valueType === 'text' && existing ? TEXT_TYPES.get(existing.type) : undefined) ?? BASE_TYPE[valueType];
  if (unit) {
    const kind = TABLE_UNITS[unit].kind;
    const existingKind = measureKindOf(existing?.dataType);
    if (existing?.dataType && existingKind !== kind) {
      return { ok: false, kind: 'unit-mismatch', detail: `${unit} does not fit ${existing.dataType}` };
    }
    if (existing?.unit && !existing.unitSiScale) return { ok: false, kind: 'unit-mismatch', detail: `the property's own unit ${existing.unit} could not be read` };
    dataType = existing?.dataType ?? MEASURE_TYPE[kind];
    value = toStored(reader, expressId, value as number, unit, dataType, existing?.unit ? existing.unitSiScale : undefined);
  }
  try {
    return { ok: true, value, dataType: validatePropertyDataType(value, dataType).dataType };
  } catch (error) {
    return { ok: false, kind: 'invalid-value', detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Quantities are only updated where they already exist (their type and unit come from the model). */
export function quantityCell(reader: ModelReader, expressId: number, quantity: Quantity, cell: string, unit?: TableUnit): CellOutcome {
  const parsed = parseCell(cell, 'real');
  if (typeof parsed !== 'number') return { ok: false, kind: 'invalid-value', detail: `"${cell}" is not a number` };
  if (!unit) return { ok: true, value: parsed };
  const kind = QUANTITY_KIND.get(quantity.type);
  if (kind !== TABLE_UNITS[unit].kind) return { ok: false, kind: 'unit-mismatch', detail: `${unit} does not fit ${QuantityType[quantity.type]}` };
  if (quantity.unit) return { ok: false, kind: 'unit-mismatch', detail: `the quantity declares its own unit ${quantity.unit}` };
  return { ok: true, value: toStored(reader, expressId, parsed, unit, MEASURE_TYPE[kind]) };
}
