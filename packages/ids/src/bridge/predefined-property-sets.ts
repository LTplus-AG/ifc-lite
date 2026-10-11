/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  EntityExtractor,
  extractAllEntityAttributes,
  getAttributeTypeForSchema,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

import type { PropertySetInfo } from '../types.js';
import { applyUnitConversion, type EntityMeasureScales } from './units.js';

/**
 * Predefined property-set entities (`IfcDoorPanelProperties`, …) are
 * connected to elements via `IfcRelDefinesByProperties` like a normal
 * pset, but their properties live as schema-defined ATTRIBUTES on the
 * entity itself. Surface them as a pset whose name is the entity's
 * `Name` and whose properties are the schema-defined attribute slots
 * beyond Name/Description.
 *
 * A measure attribute (`IfcDoorLiningProperties.LiningDepth`, an
 * `IfcPositiveLengthMeasure`) is in the project's units like any other
 * property value, so it is converted to SI the same way (#7395).
 */
export function appendPredefinedPropertySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales,
  out: PropertySetInfo[]
): void {
  appendPredefinedFromIds(store, definingPropertySetIds(store, expressId), scales, out);
}

/**
 * Predefined property sets on the element's type object (an
 * `IfcDoorLiningProperties` in an `IfcDoorType`'s `HasPropertySets`), for
 * inheritance by the occurrence like the type's ordinary property sets, and
 * converted to SI with the occurrence's units (#7395).
 */
export function typePredefinedPropertySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales
): PropertySetInfo[] {
  const typeId = store.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse')?.[0];
  if (typeId === undefined) return [];
  const out: PropertySetInfo[] = [];
  const ids = new Set([...hasPropertySetIds(store, typeId), ...definingPropertySetIds(store, typeId)]);
  appendPredefinedFromIds(store, [...ids], scales, out);
  return out;
}

function definingPropertySetIds(store: IfcDataStore, expressId: number): number[] {
  return store.relationships?.getRelated?.(expressId, RelationshipType.DefinesByProperties, 'inverse') || [];
}

/** A type object's `HasPropertySets` (attribute 5 of `IfcTypeObject`). */
function hasPropertySetIds(store: IfcDataStore, typeId: number): number[] {
  // @raw-entity-enumeration-ok point lookup of one source type object reached through the element's DefinesByType relationship
  const ref = store.entityIndex?.byId?.get?.(typeId);
  if (!ref || !store.source?.length) return [];
  const attr = new EntityExtractor(store.source).extractEntity(ref)?.attributes?.[5];
  return Array.isArray(attr) ? attr.filter((id): id is number => typeof id === 'number') : [];
}

function appendPredefinedFromIds(
  store: IfcDataStore,
  psetIds: number[],
  scales: EntityMeasureScales,
  out: PropertySetInfo[]
): void {
  for (const psetId of psetIds) {
    // @raw-entity-enumeration-ok point lookup for one source pset reached through the parser's source-snapshot relationship index; this is not a base-entity enumeration
    const ref = store.entityIndex?.byId?.get?.(psetId);
    if (!ref) continue;
    const tu = String((ref as { type?: unknown }).type).toUpperCase();
    if (tu === 'IFCPROPERTYSET' || tu === 'IFCELEMENTQUANTITY') continue;
    if (!tu.endsWith('PROPERTIES')) continue;

    const allAttrs = extractAllEntityAttributes(store, psetId);
    const psetNameAttr = allAttrs.find((a) => a.name === 'Name')?.value;
    if (typeof psetNameAttr !== 'string' || !psetNameAttr) continue;
    if (out.some((p) => p.name === psetNameAttr)) continue;

    const properties = allAttrs
      .filter(
        (a) =>
          a.name !== 'GlobalId' &&
          a.name !== 'Name' &&
          a.name !== 'Description' &&
          a.value !== undefined &&
          a.value !== ''
      )
      .map((a) => {
        // The attribute's declared EXPRESS type is its dataType (PanelOperation
        // → IFCDOORPANELOPERATIONENUM). Unknown to the schema means unknown, and
        // a dataType check fails rather than passing unchecked (#5224).
        const dataType = getAttributeTypeForSchema(tu, a.name, store.schemaVersion)?.toUpperCase();
        const value =
          typeof a.value === 'number'
            ? applyUnitConversion(a.value, undefined, dataType, scales.length, scales).value
            : a.value;
        return { name: a.name, value, dataType };
      });
    if (properties.length > 0) out.push({ name: psetNameAttr, properties });
  }
}
