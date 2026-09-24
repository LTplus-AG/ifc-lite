/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `property` and `quantity` subjects for `readSubject`: the values, the
 * unit each is recorded in (#5300), its SI factor (#5225), and the
 * `inherit` option (#5433). Split out of `read-subject.ts` for size.
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
  type IfcDataStore,
} from '@ifc-lite/parser';
import { QuantityType, RelationshipType } from '@ifc-lite/data';
import type { PropertyRule, QuantityRule } from './filter-rules.js';
import { nameMatches, stringifyValue } from './filter-match.js';
import { projectSiScale, projectUnitSymbol, quantityValueSiScale, QUANTITY_MEASURE_TYPE } from './measure-units.js';

type MeasureSubject = Omit<PropertyRule, 'op' | 'value' | 'valueKind'> | Omit<QuantityRule, 'op' | 'value'>;

export interface MeasureValue {
  present: boolean;
  values: ReadonlyArray<string | number>;
  unit?: string;
  valueUnits: ReadonlyArray<string | undefined>;
  valueSiScales: ReadonlyArray<number | undefined>;
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

function readProperty(subject: Extract<MeasureSubject, { kind: 'property' }>, store: IfcDataStore, expressId: number): MeasureValue {
  const merged = mergeInheritedPropertySets(extractPropertiesOnDemand(store, expressId), inheritedTypePsets(store, expressId));
  const values: string[] = [];
  const valueUnits: Array<string | undefined> = [];
  const valueSiScales: Array<number | undefined> = [];
  for (const set of merged) {
    if (!nameMatches(subject.setName, set.name, subject.setNameKind)) continue;
    for (const p of set.properties) {
      if (!nameMatches(subject.propertyName, p.name, subject.propertyNameKind)) continue;
      values.push(stringifyValue(p.value));
      // Own and type-level rows alike carry the property's explicit `Unit`
      // when it has one (both come from `extractPsetsFromIds`).
      valueUnits.push(p.unit ?? projectUnitSymbol(store, p.dataType));
      valueSiScales.push(p.unit !== undefined ? p.unitSiScale : projectSiScale(store, p.dataType));
    }
  }
  return { present: values.some((v) => v.trim().length > 0), values, valueUnits, valueSiScales };
}

function readQuantity(subject: Extract<MeasureSubject, { kind: 'quantity' }>, store: IfcDataStore, expressId: number): MeasureValue {
  const own = extractQuantitiesOnDemand(store, expressId);
  // Both options read the type's quantities: 'aggregation' falls back to
  // the aggregate parent only when neither the element nor its type has
  // the value, the same "own (type included) first" rule as properties.
  const sets = subject.inherit === 'type' || subject.inherit === 'aggregation'
    ? mergeInheritedQuantitySets(own, extractTypeQuantitiesOnDemand(store, expressId)?.quantities ?? [])
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
