/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  type IfcDataStore,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypePropertiesOnDemand,
  extractTypeEntityOwnProperties,
  extractTypeEntityOwnQuantities,
  extractMaterialPropertiesForMaterialId,
  mergeInheritedPropertySets,
} from '@ifc-lite/parser';
import { RelationshipType, exactTypeName } from '@ifc-lite/data';

import type { PropertySetInfo } from '../types.js';
import { idsDataTypeForQuantity } from './data-types.js';
import { appendPredefinedPropertySets, typePredefinedPropertySets } from './predefined-property-sets.js';
import { projectProperty, type RawProp } from './project-property.js';
import { resolveEntityMeasureScales, type EntityMeasureScales } from './units.js';

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
 *   3. Inherited property sets from `IfcRelDefinesByType`, predefined
 *      ones and quantity sets on the type included.
 *
 * Measure-typed properties are converted to base SI units per the
 * ENTITY'S OWN OWNING `IFCPROJECT`'s declared units — see
 * `resolveEntityMeasureScales` — so IDS literals (always metre / m² / m³)
 * compare correctly even for an entity belonging to a later `IFCPROJECT`
 * in a multi-project (federated-merge) file.
 */
export function collectAllPropertySets(
  store: IfcDataStore,
  expressId: number
): PropertySetInfo[] {
  const own: PropertySetInfo[] = [];
  const scales = resolveEntityMeasureScales(store, expressId);

  appendInstancePropertySets(store, expressId, scales, own);
  appendQuantitySets(store, expressId, scales, own);
  appendPredefinedPropertySets(store, expressId, scales, own);
  appendMaterialOwnPropertySets(store, expressId, scales, own);

  // Merged per property, not per set — see `mergeInheritedPropertySets`.
  const out = mergeInheritedPropertySets(
    own,
    inheritedPropertySets(store, expressId, scales),
  );

  if (out.length === 0) {
    return typeEntityOwnSets(store, expressId, scales);
  }
  return out;
}

function appendInstancePropertySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales,
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
      properties: (pset.properties || []).map((p) => projectProperty(p, scales)),
    });
  }
}

/**
 * `IfcPhysicalQuantity` (Qto_*) values are stored in the project's raw
 * author unit exactly like `IfcPropertySingleValue` (Pset_*) — an
 * `IfcQuantityLength`/`IfcQuantityArea`/`IfcQuantityVolume` is just as
 * much an IFC measure as a length/area/volume-typed property, so it
 * needs the same base-SI conversion `projectProperty` already applies
 * there. Route through it here too rather than building the value
 * inline, so the two paths can't drift again — see `applyUnitConversion`
 * in `units.ts` for the length/area/volume exponents.
 */
function appendQuantitySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales,
  out: PropertySetInfo[]
): void {
  let quantities = store.quantities?.getForEntity?.(expressId);
  if (!quantities || quantities.length === 0) {
    quantities = extractQuantitiesOnDemand(store, expressId);
  }
  if (!quantities || quantities.length === 0) return;

  for (const qset of quantities) out.push(quantitySetInfo(qset, scales));
}

/** The quantity-set shape both the parser's on-demand readers and the
 *  prebuilt `QuantityTable` return. */
interface QuantitySetRecord {
  name: string;
  quantities?: ReadonlyArray<{ name: string; type: number; value: number }>;
}

/** One `IfcElementQuantity` as a property set, its values in base SI. */
function quantitySetInfo(qset: QuantitySetRecord, scales: EntityMeasureScales): PropertySetInfo {
  return {
    name: qset.name,
    properties: (qset.quantities || []).map((q) =>
      projectProperty(
        {
          name: q.name,
          value: q.value,
          type: undefined,
          dataType: idsDataTypeForQuantity(q.type),
          ...quantityOwnUnit(q),
        },
        scales
      )
    ),
  };
}

/**
 * A quantity's own `Unit`, in the `unit`/`unitSiScale` shape property records
 * use. The parser's `CollectedQuantity` reports a resolved unit as
 * `explicitUnitSiScale` and an unreadable one as `explicitUnitUnresolved`;
 * quantity-table rows carry neither and fall through to the project unit.
 */
function quantityOwnUnit(quantity: object): Pick<RawProp, 'unit' | 'unitSiScale'> {
  const q = quantity as {
    explicitUnitSiScale?: number;
    explicitUnitUnresolved?: true;
    explicitUnit?: string;
  };
  if (q.explicitUnitSiScale !== undefined) {
    return { unit: q.explicitUnit ?? '', unitSiScale: q.explicitUnitSiScale };
  }
  if (q.explicitUnitUnresolved) return { unit: '#?' };
  return {};
}

/**
 * `IfcMaterialProperties` (IFC4+) / `IfcExtendedMaterialProperties`
 * (IFC2X3) attach property sets directly to an `IfcMaterial`, not
 * through `IfcRelDefinesByProperties` like every other pset. When the
 * IDS applicability targets `IfcMaterial` itself (rather than an
 * element that merely uses one), those material-owned psets are the
 * ONLY property source available — without this, a property facet on
 * `IfcMaterial` always reports the pset missing regardless of content.
 *
 * Gated on the entity's own type so this never runs for the much more
 * common "element that has a material" shape; that path goes through
 * the material facet, not this one.
 */
function appendMaterialOwnPropertySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales,
  out: PropertySetInfo[]
): void {
  if (resolveEntityTypeName(store, expressId)?.toUpperCase() !== 'IFCMATERIAL') return;

  const groups = extractMaterialPropertiesForMaterialId(store, expressId);
  for (const group of groups) {
    for (const pset of group.psets) {
      if (out.some((p) => p.name === pset.name)) continue;
      out.push({
        name: pset.name,
        properties: pset.properties.map((p) => projectProperty(p as RawProp, scales)),
      });
    }
  }
}

/**
 * Raw IFC type name for an entity, falling back from the columnar
 * entity table (which only summarises "interesting" types — resource
 * -level entities like `IfcMaterial` resolve to `'Unknown'` there) to
 * `entityIndex.byId`. Mirrors `createDataAccessor`'s `getEntityType`;
 * duplicated rather than threaded through as a parameter because only
 * this one caller needs a raw type check ahead of the accessor existing.
 */
function resolveEntityTypeName(store: IfcDataStore, expressId: number): string | undefined {
  const fromTable = store.entities ? exactTypeName(store.entities, expressId) : undefined;
  if (fromTable && fromTable !== 'Unknown') return fromTable;
  // @raw-entity-enumeration-ok point lookup for one source record to guard the parsed material-owned-property projection; this helper projects source property sets and is not a live candidate/type enumeration
  const entry = store.entityIndex?.byId?.get(expressId);
  if (!entry) return undefined;
  return typeof entry === 'object' && 'type' in entry ? String((entry as { type: unknown }).type) : undefined;
}

function inheritedPropertySets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales
): PropertySetInfo[] {
  // Source-backed extraction (WASM/columnar parse) first; it bails on stores
  // with no `source` buffer — i.e. server-parsed stores — so fall back to the
  // prebuilt property table keyed by the element's IfcTypeProduct id (issue
  // #1787), mirroring the Lists adapter's server-path type fallback.
  const inheritedPsets =
    extractTypePropertiesOnDemand(store, expressId)?.properties ??
    typePropertySetsFromTable(store, expressId);
  // The type's quantity sets are inherited like its property sets (#ISSUE):
  // `IfcTypeObject.HasPropertySets` holds both. Same two parse paths. The type
  // is resolved here and read once per type (`typeOwnQuantitySets`), so a
  // typed element whose type holds no quantity set adds next to no work.
  const sourceTypeId = store.source?.length
    ? store.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse')?.[0]
    : undefined;
  const inheritedQsets =
    sourceTypeId !== undefined
      ? typeOwnQuantitySets(store, sourceTypeId)
      : typeQuantitySetsFromTable(store, expressId);

  const inherited = typeObjectSets(
    inheritedPsets.map((pset) => ({
      name: pset.name,
      properties: (pset.properties || []).map((p) => projectProperty(p as RawProp, scales)),
    })),
    inheritedQsets.map((qset) => quantitySetInfo(qset, scales)),
  );
  // The type's predefined property sets (IfcDoorLiningProperties, ...) are
  // inherited the same way (#7395). One sharing a name with an ordinary type
  // set adds the properties that set lacks, rather than being dropped.
  for (const pset of typePredefinedPropertySets(store, expressId, scales)) {
    const same = inherited.find((p) => p.name === pset.name);
    if (!same) {
      inherited.push(pset);
      continue;
    }
    for (const prop of pset.properties) {
      if (!same.properties.some((p) => p.name === prop.name)) same.properties.push(prop);
    }
  }
  return inherited;
}

/**
 * A type object's property sets and quantity sets as one list (#ISSUE). A
 * quantity set named like one of the type's property sets adds the quantities
 * that set lacks, and the property set keeps a same-named item: the per-item
 * rule `mergeInheritedPropertySets` applies between an occurrence and its type.
 * Listed separately, the property set would fail every requirement on the
 * quantity set's items and the other way round, since IDS requires every set
 * matching the facet's `propertySet` to satisfy it. A quantity set with no such
 * property set is kept as its own set, so two same-named quantity sets stay two.
 */
function typeObjectSets(psets: PropertySetInfo[], qsets: PropertySetInfo[]): PropertySetInfo[] {
  return mergeInheritedPropertySets(psets, qsets);
}

/** Server-parsed stores (no `source`) only: the element's IfcTypeProduct, via
 *  IfcRelDefinesByType, whose sets the server materialises in the prebuilt
 *  tables under the type's own id (serverDataModel's TYPEHASPROPERTYSETS
 *  merge). Undefined for WASM stores, whose type sets the source-backed
 *  extractors already resolved, so the table fallbacks never run there. */
function serverTypeId(store: IfcDataStore, expressId: number): number | undefined {
  if (store.source && store.source.length > 0) return undefined;
  return store.relationships?.getRelated?.(expressId, RelationshipType.DefinesByType, 'inverse')?.[0];
}

/** Type-inherited property sets for server-parsed stores (#1787): the prebuilt
 *  property table for the type id. [] for WASM stores. */
function typePropertySetsFromTable(
  store: IfcDataStore,
  expressId: number
): Array<{ name: string; properties: RawProp[] }> {
  const typeId = serverTypeId(store, expressId);
  if (typeId === undefined) return [];
  const psets = store.properties?.getForEntity?.(typeId);
  return (psets ?? []) as unknown as Array<{ name: string; properties: RawProp[] }>;
}

/** Type-inherited quantity sets for server-parsed stores (#ISSUE): the prebuilt
 *  quantity table for the type id. [] for WASM stores. */
function typeQuantitySetsFromTable(store: IfcDataStore, expressId: number): QuantitySetRecord[] {
  const typeId = serverTypeId(store, expressId);
  if (typeId === undefined) return [];
  return store.quantities?.getForEntity?.(typeId) ?? [];
}

/** A type object's own `HasPropertySets`, property and quantity sets
 *  (#ISSUE), converted to SI like any other property set (#7395). */
function typeEntityOwnSets(
  store: IfcDataStore,
  expressId: number,
  scales: EntityMeasureScales
): PropertySetInfo[] {
  return typeObjectSets(
    extractTypeEntityOwnProperties(store, expressId).map((pset) => ({
      name: pset.name,
      properties: (pset.properties || []).map((p) => projectProperty(p as RawProp, scales)),
    })),
    typeOwnQuantitySets(store, expressId).map((qset) => quantitySetInfo(qset, scales)),
  );
}

type TypeOwnQuantitySets = ReturnType<typeof extractTypeEntityOwnQuantities>;
const typeOwnQuantityCache = new WeakMap<IfcDataStore, Map<number, TypeOwnQuantitySets>>();

/**
 * A type object's own quantity sets, read from the source once per store and
 * type (#ISSUE). Every occurrence inherits them, so without the memo each one
 * would decode the type entity again, also when the type holds no quantity
 * set. Safe to share: the reader derives only from the immutable source and
 * entity index, and `quantitySetInfo` copies what it projects.
 */
function typeOwnQuantitySets(store: IfcDataStore, typeId: number): TypeOwnQuantitySets {
  let byType = typeOwnQuantityCache.get(store);
  if (!byType) {
    byType = new Map();
    typeOwnQuantityCache.set(store, byType);
  }
  let sets = byType.get(typeId);
  if (!sets) {
    sets = extractTypeEntityOwnQuantities(store, typeId);
    byType.set(typeId, sets);
  }
  return sets;
}
