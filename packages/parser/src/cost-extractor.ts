/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QuantityType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { compatibilityTreeBuilder } from './cost-compatibility-tree.js';
import { costQuantityExactValue, extractCostQuantities } from './cost-quantities.js';
import { asEnum, asRef, asString, CostEntityReader } from './cost-reader.js';
import { diagnoseCostGraphs, extractCostRelationships } from './cost-relationships.js';
import { isZeroCostNumericLexeme } from './cost-step-lexemes.js';
import { getInheritanceChain } from './ifc-schema.js';
import type {
  CostAppliedValue,
  CostDiagnostic,
  CostGraphExtraction,
  CostItemInfo,
  CostQuantityDimension,
  CostQuantityInfo,
  CostScheduleInfo,
  CostValueInfo,
} from './cost-types.js';
import type { CostExtractionOptions } from './cost-overlay.js';
import { CostUnitResolver } from './cost-units.js';

function scalarString(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length === 2) return scalarString(value[1]);
  if (typeof value === 'string' && value.length > 0) return value;
  return typeof value === 'number' && Number.isFinite(value) ? value.toString() : undefined;
}

function dateTime2x3(reader: CostEntityReader, value: unknown): string | undefined {
  const pad = (part: number): string => String(part).padStart(2, '0');
  let current = asRef(value);
  let clock: string | undefined;
  const visited = new Set<number>();
  while (current !== undefined) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const entity = reader.get(current);
    if (!entity) return undefined;
    const a = entity.attributes ?? [];
    const type = entity.type.toUpperCase();
    if (type === 'IFCCALENDARDATE' &&
        typeof a[0] === 'number' && typeof a[1] === 'number' && typeof a[2] === 'number') {
      const date = `${a[2]}-${pad(a[1])}-${pad(a[0])}`;
      return clock ? `${date}T${clock}` : date;
    }
    if (type !== 'IFCDATEANDTIME') return undefined;
    if (!clock) {
      const timeId = asRef(a[1]);
      const time = timeId === undefined ? undefined : reader.get(timeId);
      const t = time?.type.toUpperCase() === 'IFCLOCALTIME' ? time.attributes ?? [] : [];
      if (typeof t[0] === 'number') {
        const minute = typeof t[1] === 'number' ? t[1] : 0;
        const second = typeof t[2] === 'number' ? Math.floor(t[2]) : 0;
        clock = `${pad(t[0])}:${pad(minute)}:${pad(second)}`;
      }
    }
    current = asRef(a[0]);
  }
  return undefined;
}

function appliedValue(
  value: unknown,
  reader: CostEntityReader,
  expressId: number,
): CostAppliedValue | undefined {
  if (!reader.attributePresent(expressId, 2)) return undefined;
  if (value === null || value === undefined) return { Kind: 'Unsupported', Raw: value };
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    const parsed = reader.decimalLexeme(expressId, 2);
    return parsed === undefined
      ? { Kind: 'Unsupported', Raw: value, InvalidNumber: true }
      : { Kind: 'Typed', Type: value[0].toUpperCase(), Value: parsed };
  }
  const reference = reader.referenceLexeme(expressId, 2);
  if (reference !== undefined && reader.get(reference)) {
    return { Kind: 'Reference', expressId: reference };
  }
  return { Kind: 'Unsupported', Raw: value };
}

function quantityType(dimension: CostQuantityDimension | undefined): QuantityType {
  switch (dimension) {
    case 'length': return QuantityType.Length;
    case 'area': return QuantityType.Area;
    case 'volume': return QuantityType.Volume;
    case 'mass': return QuantityType.Weight;
    case 'time': return QuantityType.Time;
    case 'number': return QuantityType.Number;
    default: return QuantityType.Count;
  }
}

function finiteCompatibilityNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const converted = Number(value);
  if (!Number.isFinite(converted)) return undefined;
  return converted !== 0 || isZeroCostNumericLexeme(value) ? converted : undefined;
}

/**
 * `IfcRelAssignsToControl` legitimately binds tasks, resources and actors
 * to a control (assigning a task to a cost item is exactly this
 * relationship, with the cost item as `RelatingControl`) — not just
 * products. `productExpressIds`/`productGlobalIds` are documented as an
 * `IfcProduct` view, so this discriminates the related object's type via
 * the schema-derived inheritance chain (same approach used elsewhere in
 * the parser for product/group/root classification) before it is
 * admitted (#4877).
 */
function isProductLike(reader: CostEntityReader, expressId: number): boolean {
  const type = reader.typeOf(expressId);
  if (!type) return false;
  return getInheritanceChain(type).some((ancestor) => ancestor.toUpperCase() === 'IFCPRODUCT');
}

function pushInvalidList(
  reader: CostEntityReader,
  diagnostics: CostDiagnostic[],
  expressId: number,
  index: number,
  attribute: 'CostValues' | 'CostQuantities' | 'Components',
  value: unknown,
): number[] | undefined {
  if (!reader.attributePresent(expressId, index)) return undefined;
  const refs = reader.referenceListLexeme(expressId, index);
  if (!refs || refs.length === 0 || !Array.isArray(value) || refs.length !== value.length) {
    diagnostics.push({
      Code: 'INVALID_LIST',
      Message: `${attribute} on #${expressId} must contain at least one reference`,
      Severity: 'warning',
      expressId,
    });
    return [];
  }
  return refs;
}

function extractSchedules(reader: CostEntityReader, schemaIs2x3: boolean): CostScheduleInfo[] {
  const result: CostScheduleInfo[] = [];
  for (const expressId of reader.ids('IFCCOSTSCHEDULE')) {
    const a = reader.get(expressId)?.attributes ?? [];
    result.push(schemaIs2x3 ? {
      expressId,
      GlobalId: asString(a[0]) ?? '',
      Name: asString(a[2]), Description: asString(a[3]), ObjectType: asString(a[4]),
      SubmittedOn: dateTime2x3(reader, a[7]), Status: asString(a[8]),
      UpdateDate: dateTime2x3(reader, a[10]), ID: asString(a[11]), PredefinedType: asEnum(a[12]),
      globalId: asString(a[0]) ?? '', name: asString(a[2]) ?? '',
      predefinedType: asEnum(a[12]), status: asString(a[8]),
      submittedOn: dateTime2x3(reader, a[7]), updateDate: dateTime2x3(reader, a[10]),
      costItemGlobalIds: [],
    } : {
      expressId,
      GlobalId: asString(a[0]) ?? '',
      Name: asString(a[2]), Description: asString(a[3]), ObjectType: asString(a[4]),
      Identification: asString(a[5]), PredefinedType: asEnum(a[6]), Status: asString(a[7]),
      SubmittedOn: scalarString(a[8]), UpdateDate: scalarString(a[9]),
      globalId: asString(a[0]) ?? '', name: asString(a[2]) ?? '',
      predefinedType: asEnum(a[6]), status: asString(a[7]),
      submittedOn: scalarString(a[8]), updateDate: scalarString(a[9]),
      costItemGlobalIds: [],
    });
  }
  return result;
}

function extractItems(
  reader: CostEntityReader,
  schemaIs2x3: boolean,
  diagnostics: CostDiagnostic[],
): CostItemInfo[] {
  return reader.ids('IFCCOSTITEM').map((expressId) => {
    const a = reader.get(expressId)?.attributes ?? [];
    const base: CostItemInfo = {
      expressId, GlobalId: asString(a[0]) ?? '', Name: asString(a[2]),
      Description: asString(a[3]), ObjectType: asString(a[4]),
      globalId: asString(a[0]) ?? '', name: asString(a[2]) ?? '',
      childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
      controllingScheduleGlobalIds: [],
    };
    if (schemaIs2x3) return base;
    base.Identification = asString(a[5]);
    base.PredefinedType = asEnum(a[6]);
    base.predefinedType = base.PredefinedType;
    base.CostValues = pushInvalidList(reader, diagnostics, expressId, 7, 'CostValues', a[7]);
    base.CostQuantities = pushInvalidList(reader, diagnostics, expressId, 8, 'CostQuantities', a[8]);
    return base;
  });
}

function extractValues(
  reader: CostEntityReader,
  schemaIs2x3: boolean,
  diagnostics: CostDiagnostic[],
): CostValueInfo[] {
  const ids = new Set([...reader.ids('IFCCOSTVALUE'), ...reader.ids('IFCAPPLIEDVALUE')]);
  const values: CostValueInfo[] = [];
  for (const expressId of ids) {
    const entity = reader.get(expressId);
    if (!entity) continue;
    const a = entity.attributes ?? [];
    const AppliedValue = appliedValue(a[2], reader, expressId);
    const ApplicableDate = schemaIs2x3 ? dateTime2x3(reader, a[4]) : scalarString(a[4]);
    const FixedUntilDate = schemaIs2x3 ? dateTime2x3(reader, a[5]) : scalarString(a[5]);
    const Condition = asString(a[7]);
    const InvalidCondition = reader.attributePresent(expressId, 7) && Condition === undefined;
    const UnitBasis = reader.referenceLexeme(expressId, 3);
    const InvalidUnitBasis = reader.attributePresent(expressId, 3) && UnitBasis === undefined;
    const base: CostValueInfo = {
      expressId,
      Type: entity.type.toUpperCase() === 'IFCCOSTVALUE' ? 'IfcCostValue' : 'IfcAppliedValue',
      Name: asString(a[0]), Description: asString(a[1]), AppliedValue,
      UnitBasis, InvalidUnitBasis: InvalidUnitBasis || undefined, ApplicableDate, FixedUntilDate,
      InvalidCondition: InvalidCondition || undefined,
      name: asString(a[0]), description: asString(a[1]),
      appliedValue: AppliedValue?.Kind === 'Typed'
        ? finiteCompatibilityNumber(AppliedValue.Value)
        : undefined,
      applicableDate: ApplicableDate, fixedUntilDate: FixedUntilDate,
    };
    if (schemaIs2x3) {
      base.CostType = asString(a[6]);
      base.Condition = Condition;
      base.condition = base.Condition;
    } else {
      base.Category = asString(a[6]);
      base.Condition = Condition;
      base.ArithmeticOperator = asEnum(a[8]);
      base.Components = pushInvalidList(reader, diagnostics, expressId, 9, 'Components', a[9]);
      base.category = base.Category;
      base.condition = base.Condition;
      base.arithmeticOperator = base.ArithmeticOperator;
    }
    values.push(base);
  }
  return values;
}

/** Extract a schema-aware, read-only IFC cost graph from a parsed store. */
export function extractCostOnDemand(
  store: IfcDataStore,
  options?: CostExtractionOptions,
): CostGraphExtraction {
  const schema = store.schemaVersion;
  const diagnostics: CostDiagnostic[] = [];
  const empty = (): CostGraphExtraction => ({
    SchemaVersion: schema, CostSchedules: [], CostItems: [], CostValues: [],
    CostQuantities: [], Units: [], MeasuresWithUnit: [], ProjectUnits: {}, Relationships: [], Diagnostics: diagnostics,
    HasCostData: false, costSchedules: [], costItems: [], hasCost: false,
  });
  if (!store.source?.length) return empty();
  const reader = new CostEntityReader(store, options?.overlay, diagnostics);
  const hasCost = reader.ids('IFCCOSTSCHEDULE').length + reader.ids('IFCCOSTITEM').length +
    reader.ids('IFCCOSTVALUE').length + reader.ids('IFCAPPLIEDVALUE').length > 0;
  if (!hasCost) return empty();
  if (schema === 'IFC5') {
    diagnostics.push({ Code: 'UNSUPPORTED_SCHEMA', Message: 'IFC5 cost extraction is not supported', Severity: 'error' });
    return { ...empty(), HasCostData: true };
  }
  const schemaIs2x3 = schema === 'IFC2X3';
  if (schemaIs2x3) diagnostics.push({
    Code: 'IFC2X3_PARTIAL_READ',
    Message: 'IFC2X3 cost metadata and relationships are preserved, but values are not evaluated',
    Severity: 'warning',
  });
  const CostSchedules = extractSchedules(reader, schemaIs2x3);
  const CostItems = extractItems(reader, schemaIs2x3, diagnostics);
  const CostValues = extractValues(reader, schemaIs2x3, diagnostics);
  const itemIds = new Set(CostItems.map(item => item.expressId));
  const scheduleIds = new Set(CostSchedules.map(schedule => schedule.expressId));
  const valueIds = new Set(CostValues.flatMap(value => value.expressId === undefined ? [] : [value.expressId]));
  const Relationships = extractCostRelationships(reader, itemIds, scheduleIds, valueIds);
  const quantityMap = new Map<number, CostQuantityInfo>();
  extractCostQuantities(reader, CostItems.flatMap(item => item.CostQuantities ?? []), quantityMap, diagnostics);
  const unitResolver = new CostUnitResolver(reader, diagnostics);
  for (const quantity of quantityMap.values()) {
    if (quantity.Unit !== undefined) unitResolver.resolve(quantity.Unit);
  }
  for (const value of CostValues) {
    if (value.UnitBasis !== undefined) {
      const basis = unitResolver.resolveMeasureWithUnit(value.UnitBasis);
      const compatibility = unitResolver.compatibilityMeasureWithUnit(value.UnitBasis, basis);
      const valueComponent = finiteCompatibilityNumber(compatibility?.Value);
      const unitSiScale = finiteCompatibilityNumber(compatibility?.Unit?.Scale);
      value.unitBasis = compatibility ? {
        valueComponent,
        unitSymbol: compatibility.Unit?.Scale === undefined ? undefined : compatibility.Unit.Symbol,
        unitSiScale,
      } : undefined;
    }
    if (value.AppliedValue?.Kind === 'Reference' && reader.typeOf(value.AppliedValue.expressId) === 'IFCMEASUREWITHUNIT') {
      unitResolver.resolveMeasureWithUnit(value.AppliedValue.expressId);
    }
  }
  diagnoseCostGraphs(Relationships, CostValues, itemIds, diagnostics);
  const schedules = new Map(CostSchedules.map(schedule => [schedule.expressId, schedule]));
  const items = new Map(CostItems.map(item => [item.expressId, item]));
  const values = new Map(CostValues.map(value => [value.expressId, value]));
  const legacyComponents = compatibilityTreeBuilder(values, diagnostics);
  const quantities = new Map([...quantityMap.values()].map(quantity => [quantity.expressId, quantity]));
  for (const value of CostValues) {
    for (const componentId of value.Components ?? []) {
      if (!values.has(componentId)) diagnostics.push({
        Code: 'MISSING_REFERENCE',
        Message: `IfcAppliedValue component #${componentId} cannot be resolved`,
        Severity: 'error', expressId: value.expressId, RelatedExpressId: componentId,
      });
    }
  }
  const compatibilityBuilt = new Set<number>();
  for (const item of CostItems) {
    for (const valueId of item.CostValues ?? []) {
      const value = values.get(valueId);
      if (!value) diagnostics.push({
        Code: 'MISSING_REFERENCE',
        Message: `IfcCostValue #${valueId} cannot be resolved`,
        Severity: 'error', expressId: item.expressId, RelatedExpressId: valueId,
      });
      else if (value.Type !== 'IfcCostValue') diagnostics.push({
        Code: 'INVALID_LIST',
        Message: `CostValues on IfcCostItem #${item.expressId} must reference IfcCostValue`,
        Severity: 'error', expressId: item.expressId, RelatedExpressId: valueId,
      });
    }
    item.costValues = item.CostValues
      ?.map(id => {
        const value = values.get(id);
        if (value && !compatibilityBuilt.has(id)) {
          value.components = legacyComponents(id);
          compatibilityBuilt.add(id);
        }
        return value;
      })
      .filter((entry): entry is CostValueInfo => entry !== undefined);
    item.costQuantities = item.CostQuantities
      ?.map(id => quantities.get(id))
      .filter((entry): entry is CostQuantityInfo => entry !== undefined && costQuantityExactValue(entry) !== undefined)
      .flatMap(quantity => {
        const value = finiteCompatibilityNumber(costQuantityExactValue(quantity));
        if (value === undefined) return [];
        const unit = quantity.Unit === undefined ? undefined : unitResolver.Units.get(quantity.Unit);
        const explicitUnitSiScale = finiteCompatibilityNumber(unit?.Scale);
        return [{
          name: quantity.Name ?? '',
          type: quantityType(quantity.Dimension),
          value,
          ...(explicitUnitSiScale !== undefined ? { explicitUnitSiScale } : {}),
        }];
      });
    if (item.costQuantities?.length === 0) item.costQuantities = undefined;
  }
  for (const relation of Relationships) {
    if (relation.Type === 'IfcRelNests' && relation.RelatingObject !== undefined) {
      const parent = items.get(relation.RelatingObject);
      if (!parent) continue;
      for (const childId of relation.RelatedObjects ?? []) {
        const child = items.get(childId);
        if (!child) continue;
        parent.childGlobalIds.push(child.GlobalId ?? '');
        child.parentGlobalId ??= parent.GlobalId ?? '';
      }
    } else if ((relation.Type === 'IfcRelAssignsToControl' || relation.Type === 'IfcRelSchedulesCostItems') &&
               relation.RelatingControl !== undefined) {
      const schedule = schedules.get(relation.RelatingControl);
      const item = items.get(relation.RelatingControl);
      for (const relatedId of relation.RelatedObjects ?? []) {
        const relatedItem = items.get(relatedId);
        if (schedule && relatedItem) {
          schedule.costItemGlobalIds.push(relatedItem.GlobalId ?? '');
          relatedItem.controllingScheduleGlobalIds.push(schedule.GlobalId ?? '');
        } else if (item && isProductLike(reader, relatedId)) {
          item.productExpressIds.push(relatedId);
          item.productGlobalIds.push(store.entities?.getGlobalId?.(relatedId) ?? '');
        }
      }
    } else if (relation.Type === 'IfcRelAssignsToProduct' && relation.RelatingProduct !== undefined) {
      for (const relatedId of relation.RelatedObjects ?? []) {
        const item = items.get(relatedId);
        if (!item) continue;
        item.productExpressIds.push(relation.RelatingProduct);
        item.productGlobalIds.push(store.entities?.getGlobalId?.(relation.RelatingProduct) ?? '');
      }
    }
  }
  return {
    SchemaVersion: schema, CostSchedules, CostItems, CostValues,
    CostQuantities: [...quantityMap.values()], Units: [...unitResolver.Units.values()],
    MeasuresWithUnit: [...unitResolver.MeasuresWithUnit.values()],
    ProjectUnits: Object.fromEntries(
      [...unitResolver.ProjectUnits.entries()].map(([dimension, unit]) => [dimension, unit.expressId]),
    ),
    Relationships, Diagnostics: diagnostics, HasCostData: true, Currency: unitResolver.Currency,
    costSchedules: CostSchedules, costItems: CostItems, hasCost: true,
  };
}
