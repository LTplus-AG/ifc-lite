/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypePropertiesOnDemand,
  extractTypeEntityOwnProperties,
  extractAllEntityAttributes,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

import type { PropertySetInfo } from '../types.js';
import { idsDataTypeForProperty, idsDataTypeForQuantity } from './data-types.js';
import { applyUnitConversion } from './units.js';

interface RawProp {
  name: string;
  value: unknown;
  type: unknown;
  values?: string[];
  dataType?: string;
}

/**
 * IDS treats `IfcElementQuantity` (Qto_*) and `IfcPropertySet` (Pset_*)
 * uniformly — both surface as "property sets" with named values. The
 * parser stores them in separate columnar tables, so we merge here.
 *
 * Surfaces three sources:
 *   1. The instance's own property sets (IfcPropertySet via
 *      IfcRelDefinesByProperties).
 *   2. Predefined property sets (IfcDoorPanelProperties etc.) where
 *      the entity's schema-defined attributes act as property names.
 *   3. Inherited property sets from `IfcRelDefinesByType`.
 *
 * Length-typed properties are converted to base SI units per the
 * project's `lengthUnitScale` so IDS literals (always in metres)
 * compare correctly.
 */
export function collectAllPropertySets(
  store: IfcDataStore,
  expressId: number
): PropertySetInfo[] {
  const out: PropertySetInfo[] = [];
  const scale = store.lengthUnitScale;

  appendInstancePropertySets(store, expressId, scale, out);
  appendQuantitySets(store, expressId, out);
  appendPredefinedPropertySets(store, expressId, out);
  appendInheritedPropertySets(store, expressId, scale, out);

  if (out.length === 0) {
    appendTypeEntityOwnProperties(store, expressId, out);
  }
  return out;
}

function appendInstancePropertySets(
  store: IfcDataStore,
  expressId: number,
  scale: number | undefined,
  out: PropertySetInfo[]
): void {
  let props = store.properties?.getForEntity?.(expressId) as
    | Array<{ name: string; properties: RawProp[] }>
    | undefined;
  if (!props || props.length === 0) {
    props = extractPropertiesOnDemand(store, expressId) as Array<{
      name: string;
      properties: RawProp[];
    }>;
  }
  if (!props || props.length === 0) return;

  for (const pset of props) {
    out.push({
      name: pset.name,
      properties: (pset.properties || []).map((p) => projectProperty(p, scale)),
    });
  }
}

function appendQuantitySets(
  store: IfcDataStore,
  expressId: number,
  out: PropertySetInfo[]
): void {
  let quantities = store.quantities?.getForEntity?.(expressId);
  if (!quantities || quantities.length === 0) {
    quantities = extractQuantitiesOnDemand(store, expressId);
  }
  if (!quantities || quantities.length === 0) return;

  for (const qset of quantities) {
    out.push({
      name: qset.name,
      properties: (qset.quantities || []).map((q) => ({
        name: q.name,
        value: q.value,
        dataType: idsDataTypeForQuantity(q.type),
      })),
    });
  }
}

/**
 * Predefined property-set entities (`IfcDoorPanelProperties`, …) are
 * connected to elements via `IfcRelDefinesByProperties` like a normal
 * pset, but their properties live as schema-defined ATTRIBUTES on the
 * entity itself. Surface them as a pset whose name is the entity's
 * `Name` and whose properties are the schema-defined attribute slots
 * beyond Name/Description.
 */
function appendPredefinedPropertySets(
  store: IfcDataStore,
  expressId: number,
  out: PropertySetInfo[]
): void {
  const psetIds =
    store.relationships?.getRelated?.(
      expressId,
      RelationshipType.DefinesByProperties,
      'inverse'
    ) || [];

  for (const psetId of psetIds) {
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
      .map((a) => ({
        name: a.name,
        value: a.value,
        // dataType intentionally left empty: without a per-attribute
        // schema lookup we can't know if PanelOperation is IFCDOORPANELOPERATIONENUM
        // vs anything else. The IDS dataType gate then no-ops for these slots.
        dataType: '',
      }));
    if (properties.length > 0) out.push({ name: psetNameAttr, properties });
  }
}

function appendInheritedPropertySets(
  store: IfcDataStore,
  expressId: number,
  scale: number | undefined,
  out: PropertySetInfo[]
): void {
  const inherited = extractTypePropertiesOnDemand(store, expressId);
  if (!inherited || !inherited.properties || inherited.properties.length === 0)
    return;

  const seen = new Set(out.map((p) => p.name));
  for (const pset of inherited.properties) {
    if (seen.has(pset.name)) continue;
    out.push({
      name: pset.name,
      properties: (pset.properties || []).map((p) =>
        projectProperty(p as RawProp, scale)
      ),
    });
  }
}

function appendTypeEntityOwnProperties(
  store: IfcDataStore,
  expressId: number,
  out: PropertySetInfo[]
): void {
  const typePsets = extractTypeEntityOwnProperties(store, expressId);
  if (typePsets.length === 0) return;
  for (const pset of typePsets) {
    out.push({
      name: pset.name,
      properties: (pset.properties || []).map((p) => ({
        name: p.name,
        value: Array.isArray(p.value)
          ? JSON.stringify(p.value)
          : (p.value as string | number | boolean | null),
        dataType: idsDataTypeForProperty(p.type as number | string | undefined),
        ...(Array.isArray(p.values) && p.values.length > 0
          ? { values: p.values }
          : {}),
      })),
    });
  }
}

/**
 * Project a raw parser property record into the validator's
 * `PropertySetInfo['properties'][number]` shape — applies unit
 * conversion and resolves the IDS dataType. Multi-valued properties
 * (lists, enumerations, table values) suppress dataType so the
 * validator's dataType gate falls through to the value match.
 */
function projectProperty(
  p: RawProp,
  scale: number | undefined
): PropertySetInfo['properties'][number] {
  const hasMultiValue = Array.isArray(p.values) && p.values.length > 0;
  const dataType =
    p.dataType ??
    (hasMultiValue ? undefined : idsDataTypeForProperty(p.type as number | string | undefined));
  const baseValue = Array.isArray(p.value)
    ? JSON.stringify(p.value)
    : (p.value as string | number | boolean | null);
  const baseValues = hasMultiValue ? (p.values as string[]) : undefined;
  const converted = applyUnitConversion(baseValue, baseValues, dataType, scale);
  return {
    name: p.name,
    value: converted.value,
    dataType: dataType ?? '',
    ...(converted.values ? { values: converted.values } : {}),
  };
}
