/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `property` and `quantity` subjects for `readSubject`: the values, the
 * unit each is recorded in (#5300), its SI factor (#5225), the
 * `inherit` option (#5433), and a property's complex-property
 * `memberPath` (#5475). Split out of `read-subject.ts` for size.
 *
 * `inherit` (`SubjectReadOptions`):
 * - absent: the element's own values; a property also reads its type's
 *   property sets, per IFC's own inheritance (as it always has).
 * - `'type'`: a quantity also reads its type's quantity sets (properties
 *   already do, so for them it changes nothing).
 * - `'aggregation'`: when the element has no value of its own (type values
 *   included, quantities too), the nearest `IfcRelAggregates` ancestor
 *   that has one supplies it. The walk is iterative with a visited set (AGENTS.md
 *   "Bounding walks"), so a cyclic aggregation in a broken file ends.
 */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypePropertiesOnDemand,
  extractTypeQuantitiesOnDemand,
  mergeInheritedPropertySets,
  mergeInheritedQuantitySets,
  type ExtractedProperty,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { QuantityType, RelationshipType } from '@ifc-lite/data';
import type { PropertyRule, QuantityRule } from './filter-rules.js';
import { nameMatches, propertyCandidates, stringifyValue } from './filter-match.js';
import { projectSiScale, projectUnitSymbol, quantityValueSiScale, QUANTITY_MEASURE_TYPE } from './measure-units.js';

type MeasureSubject = Omit<PropertyRule, 'op' | 'value' | 'valueKind'> | Omit<QuantityRule, 'op' | 'value'>;

export interface MeasureValue {
  present: boolean;
  values: ReadonlyArray<string | number>;
  unit?: string;
  valueUnits: ReadonlyArray<string | undefined>;
  valueSiScales: ReadonlyArray<number | undefined>;
  /** Properties only: one display value per matched property, a list or table as its joined text. */
  displayValues?: ReadonlyArray<string>;
}

/** `expressId`'s type-level property sets via `IfcRelDefinesByType`. */
function inheritedTypePsets(store: IfcDataStore, expressId: number) {
  if (!store.relationships) return [];
  const typeIds = store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
  if (typeIds.length === 0) return [];
  if (store.source && store.source.length > 0) {
    return extractTypePropertiesOnDemand(store, expressId)?.properties ?? [];
  }
  return (store.properties?.getForEntity?.(typeIds[0]) ?? []) as ReturnType<typeof extractPropertiesOnDemand>;
}

/**
 * The members of `property` that `memberPath` names, one level per entry
 * (#5475): only an `IfcComplexProperty` has members, so any other property,
 * or a name no member has, yields none. No `memberPath`: the property itself.
 */
function complexMembers(property: ExtractedProperty, memberPath: readonly string[] | undefined): ExtractedProperty[] {
  let level = [property];
  for (const name of memberPath ?? []) {
    const wanted = name.toLowerCase();
    level = level.flatMap((p) => (p.members ?? []).filter((m) => m.name.toLowerCase() === wanted));
  }
  return level;
}

function readProperty(subject: Extract<MeasureSubject, { kind: 'property' }>, store: IfcDataStore, expressId: number): MeasureValue {
  const merged = mergeInheritedPropertySets(extractPropertiesOnDemand(store, expressId), inheritedTypePsets(store, expressId));
  const values: string[] = [];
  const valueUnits: Array<string | undefined> = [];
  const valueSiScales: Array<number | undefined> = [];
  const displayValues: string[] = [];
  for (const set of merged) {
    if (!nameMatches(subject.setName, set.name, subject.setNameKind)) continue;
    const named = set.properties.filter((p) => nameMatches(subject.propertyName, p.name, subject.propertyNameKind));
    for (const p of named.flatMap((property) => complexMembers(property, subject.memberPath))) {
      // Every candidate of a list, enumerated or table value (#5475); they
      // share the property's unit.
      const unit = p.unit ?? projectUnitSymbol(store, p.dataType);
      const siScale = p.unit !== undefined ? p.unitSiScale : projectSiScale(store, p.dataType);
      displayValues.push(stringifyValue(p.value));
      for (const value of propertyCandidates(p)) {
        values.push(value);
        valueUnits.push(unit);
        valueSiScales.push(siScale);
      }
    }
  }
  return { present: values.some((v) => v.trim().length > 0), values, valueUnits, valueSiScales, displayValues };
}

/**
 * `expressId`'s type-level quantity sets: parsed from the source, or for a
 * table-backed (server-parsed) store with no source, the type's rows in
 * `store.quantities`, the same branch `inheritedTypePsets` takes (review, #5440).
 */
function inheritedTypeQsets(store: IfcDataStore, expressId: number) {
  if (store.source && store.source.length > 0) return extractTypeQuantitiesOnDemand(store, expressId)?.quantities ?? [];
  const typeIds = store.relationships?.getRelated(expressId, RelationshipType.DefinesByType, 'inverse') ?? [];
  return typeIds.length > 0 ? (store.quantities?.getForEntity?.(typeIds[0]) ?? []) : [];
}

function readQuantity(subject: Extract<MeasureSubject, { kind: 'quantity' }>, store: IfcDataStore, expressId: number): MeasureValue {
  const own = extractQuantitiesOnDemand(store, expressId);
  // Both options read the type's quantities: 'aggregation' falls back to
  // the aggregate parent only when neither the element nor its type has
  // the value, the same "own (type included) first" rule as properties.
  const sets = subject.inherit === 'type' || subject.inherit === 'aggregation'
    ? mergeInheritedQuantitySets(own, inheritedTypeQsets(store, expressId))
    : own;
  const values: number[] = [];
  const valueUnits: Array<string | undefined> = [];
  const valueSiScales: Array<number | undefined> = [];
  for (const qset of sets) {
    if (!nameMatches(subject.setName, qset.name, subject.setNameKind)) continue;
    for (const q of qset.quantities) {
      if (!nameMatches(subject.quantityName, q.name, subject.quantityNameKind)) continue;
      values.push(q.value);
      // An explicit `IfcPhysicalSimpleQuantity.Unit` overrides the project
      // assignment, for display as much as for the check.
      valueUnits.push(q.explicitUnit ?? projectUnitSymbol(store, QUANTITY_MEASURE_TYPE[q.type as QuantityType]));
      valueSiScales.push(quantityValueSiScale(store, q));
    }
  }
  return { present: values.length > 0, values, unit: valueUnits.find((u) => u !== undefined), valueUnits, valueSiScales };
}

function readOwn(subject: MeasureSubject, store: IfcDataStore, expressId: number): MeasureValue {
  return subject.kind === 'property' ? readProperty(subject, store, expressId) : readQuantity(subject, store, expressId);
}

export function readMeasureSubject(subject: MeasureSubject, store: IfcDataStore, expressId: number): MeasureValue {
  const own = readOwn(subject, store, expressId);
  if (own.present || subject.inherit !== 'aggregation' || !store.relationships) return own;
  const visited = new Set<number>([expressId]);
  let frontier = store.relationships.getRelated(expressId, RelationshipType.Aggregates, 'inverse');
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const parent of frontier) {
      if (visited.has(parent)) continue;
      visited.add(parent);
      const value = readOwn(subject, store, parent);
      if (value.present) return value;
      next.push(...store.relationships.getRelated(parent, RelationshipType.Aggregates, 'inverse'));
    }
    frontier = next;
  }
  return own;
}
