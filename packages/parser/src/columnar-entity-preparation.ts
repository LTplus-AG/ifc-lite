/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef } from './types.js';
import type { ScannedEntityColumns } from './entity-refs-from-index.js';
import { compactEntityIndexFromColumns } from './compact-entity-index-transport.js';
import { buildCompactEntityIndexAsync } from './compact-entity-index.js';
import { selectEntityColumns } from './select-entity-columns.js';
import { getInheritanceChain } from './ifc-schema.js';
import {
  GEOMETRY_TYPES, SPATIAL_TYPES, HIERARCHY_REL_TYPES, PROPERTY_REL_TYPES,
  PROPERTY_ENTITY_TYPES, PROPERTY_CONTAINER_TYPES, ASSOCIATION_REL_TYPES, isIfcTypeLikeEntity,
} from './columnar-parser-indexes.js';

export type ColumnarEntityInput = EntityRef[] | ScannedEntityColumns;

/** Shared categorization for scanned objects and pre-pass columns. #3985 */
export async function prepareColumnarEntities(
  input: ColumnarEntityInput,
  deferPropertyAtomIndex: boolean,
  yieldIfNeeded: () => Promise<void>,
) {
  // Single pass: build byType index AND categorize entities simultaneously.
  // Uses a type-name cache to avoid calling .toUpperCase() on 4.4M refs
  // (only ~776 unique type names in IFC4).
  const byType = new Map<string, number[]>();
  const typeUpperCache = new Map<string, string>();
  const getTypeUpper = (type: string) => {
      let upper = typeUpperCache.get(type);
      if (upper === undefined) {
          upper = type.toUpperCase();
          typeUpperCache.set(type, upper);
      }
      return upper;
  };

  // Non-product helper entities that on-demand extraction / StepExporter
  // need addressable in `byId`. These are not IfcProduct subtypes so the
  // schema-driven IFCPRODUCT subtype check below cannot capture them.
  // Without them, findPreferredGeometricRepresentationContextId() and
  // findLengthUnitReference() fail because the entities are missing from
  // the compact entity index.
  const RELEVANT_NON_PRODUCT_HELPERS = new Set([
      'IFCGEOMETRICREPRESENTATIONCONTEXT', 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
      'IFCUNITASSIGNMENT', 'IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT',
      'IFCDERIVEDUNIT', 'IFCDERIVEDUNITELEMENT', 'IFCMEASUREWITHUNIT',
      'IFCDIMENSIONALEXPONENTS',
      'IFCMAPCONVERSION', 'IFCPROJECTEDCRS',
      'IFCMATERIALLAYER', 'IFCMATERIALLAYERSET', 'IFCMATERIALLAYERSETUSAGE',
      'IFCMATERIALCONSTITUENTSET', 'IFCMATERIALCONSTITUENT',
      'IFCMATERIALPROFILESET', 'IFCMATERIALPROFILE', 'IFCMATERIAL',
      'IFCCLASSIFICATION', 'IFCCLASSIFICATIONREFERENCE',
      'IFCDOCUMENTINFORMATION', 'IFCDOCUMENTREFERENCE',
  ]);

  // Schema-driven inclusion: every IfcProduct subtype belongs in the
  // EntityTable. The previous hardcoded enumeration of IFC4 building-
  // element leaves (IFCWALL, IFCSLAB, …) and IFC4x3 infrastructure
  // leaves (IFCREFERENT, IFCSIGNAL, IFCALIGNMENT, IFCPAVEMENT, …) drifted
  // with every schema bump — new entities silently became CAT_SKIP and
  // disappeared from the hierarchy panel. The generated schema registry
  // already knows the full inheritance chain, so use it.
  const RELEVANT_PRODUCT_ROOTS = new Set(['IFCPRODUCT']);

  // IfcGroup family (IfcZone, IfcSystem, IfcDistributionSystem,
  // IfcBuildingSystem, IfcDistributionCircuit, …). These are NOT
  // IfcProduct subtypes, so without an explicit branch they fall through
  // to CAT_SKIP and never enter the EntityTable — leaving their Name
  // unresolvable (`getName` → '') and making them invisible to
  // `getByType`. The Relationships card then shows "Group #<id>" and the
  // lens/lists can't surface them. Route them into their own bucket so we
  // can extract Name/LongName/ObjectType for the group label (#1075).
  const GROUP_ROOTS = new Set(['IFCGROUP']);

  // Category constants for the lookup cache
  const CAT_SKIP = 0, CAT_SPATIAL = 1, CAT_GEOMETRY = 2, CAT_HIERARCHY_REL = 3,
        CAT_PROPERTY_REL = 4, CAT_PROPERTY_ENTITY = 5, CAT_ASSOCIATION_REL = 6,
        CAT_TYPE_OBJECT = 7, CAT_RELEVANT = 8, CAT_GROUP = 9;


  /** Returns true if `upper` (already uppercased) is a subtype of any type in `set`. */
  function isSubtypeOfAny(upper: string, set: Set<string>): boolean {
      const chain = getInheritanceChain(upper);
      return chain.some(ancestor => set.has(ancestor.toUpperCase()));
  }

  // Cache: type name → category (avoids 4.4M .toUpperCase() calls)
  const typeCategoryCache = new Map<string, number>();
  function getCategory(type: string): number {
      let cat = typeCategoryCache.get(type);
      if (cat !== undefined) return cat;
      const upper = getTypeUpper(type);
      if (SPATIAL_TYPES.has(upper) || isSubtypeOfAny(upper, SPATIAL_TYPES)) cat = CAT_SPATIAL;
      else if (GEOMETRY_TYPES.has(upper) || isSubtypeOfAny(upper, GEOMETRY_TYPES)) cat = CAT_GEOMETRY;
      else if (HIERARCHY_REL_TYPES.has(upper)) cat = CAT_HIERARCHY_REL;
      else if (PROPERTY_REL_TYPES.has(upper)) cat = CAT_PROPERTY_REL;
      else if (PROPERTY_ENTITY_TYPES.has(upper)) cat = CAT_PROPERTY_ENTITY;
      else if (ASSOCIATION_REL_TYPES.has(upper)) cat = CAT_ASSOCIATION_REL;
      else if (isIfcTypeLikeEntity(upper)) cat = CAT_TYPE_OBJECT;
      else if (isSubtypeOfAny(upper, GROUP_ROOTS)) cat = CAT_GROUP;
      else if (
          RELEVANT_NON_PRODUCT_HELPERS.has(upper)
          || isSubtypeOfAny(upper, RELEVANT_PRODUCT_ROOTS)
          || upper.startsWith('IFCREL')
      ) cat = CAT_RELEVANT;
      else cat = CAT_SKIP;
      typeCategoryCache.set(type, cat);
      return cat;
  }


  const refs = Array.isArray(input) ? input : undefined;
  const columns = Array.isArray(input) ? undefined : input;
  const count = refs ? refs.length : columns!.expressIds.length;
  const spatialRefs: EntityRef[] = [];
  const geometryRefs: EntityRef[] = [];
  const relationshipRefs: EntityRef[] = [];
  const propertyRelRefs: EntityRef[] = [];
  const propertyContainerRefs: EntityRef[] = [];
  const propertyAtomRefs: EntityRef[] = [];
  const deferredRows: number[] = [];
  let propertyAtomCount = 0;
  const associationRelRefs: EntityRef[] = [];
  const typeObjectRefs: EntityRef[] = [];
  const otherRelevantRefs: EntityRef[] = [];
  const groupRefs: EntityRef[] = [];

  for (let i = 0; i < count; i++) {
    if ((i & 0x3FF) === 0) await yieldIfNeeded();
    const type = refs ? refs[i].type : columns!.typeStrings[columns!.typeIndices[i]];
    const id = refs ? refs[i].expressId : columns!.expressIds[i];
    const cat = getCategory(type);
    const atom = cat === CAT_PROPERTY_ENTITY && !PROPERTY_CONTAINER_TYPES.has(getTypeUpper(type));
    if (!deferPropertyAtomIndex || !atom) {
      const typeKey = getTypeUpper(type);
      let list = byType.get(typeKey);
      if (!list) { list = []; byType.set(typeKey, list); }
      list.push(id);
    }
    if (atom) {
      propertyAtomCount++;
      if (deferPropertyAtomIndex) {
  if (refs) propertyAtomRefs.push(refs[i]);
  else deferredRows.push(i);
      }
      continue;
    }
    // Helper records still remain in both complete indexes. They do not need
    // a transient EntityRef merely to copy their numeric fields back out.
    if (cat === CAT_SKIP) continue;
    const ref = refs ? refs[i] : {
      expressId: id, type, byteOffset: columns!.byteOffsets[i],
      byteLength: columns!.byteLengths[i], lineNumber: 0,
    };
    if (cat === CAT_SPATIAL) spatialRefs.push(ref);
    else if (cat === CAT_GEOMETRY) geometryRefs.push(ref);
    else if (cat === CAT_HIERARCHY_REL) relationshipRefs.push(ref);
    else if (cat === CAT_PROPERTY_REL) propertyRelRefs.push(ref);
    else if (cat === CAT_PROPERTY_ENTITY) propertyContainerRefs.push(ref);
    else if (cat === CAT_ASSOCIATION_REL) associationRelRefs.push(ref);
    else if (cat === CAT_TYPE_OBJECT) typeObjectRefs.push(ref);
    else if (cat === CAT_GROUP) groupRefs.push(ref);
    else if (cat === CAT_RELEVANT) otherRelevantRefs.push(ref);
  }

  const isPrimary = (type: string) => !deferPropertyAtomIndex
    || getCategory(type) !== CAT_PROPERTY_ENTITY || PROPERTY_CONTAINER_TYPES.has(getTypeUpper(type));
  const indexedCount = count - (deferPropertyAtomIndex ? propertyAtomCount : 0);
  return {
    byType, getTypeUpper, indexedCount, propertyAtomCount,
    spatialRefs, geometryRefs, relationshipRefs, propertyRelRefs,
    propertyContainerRefs, associationRelRefs, typeObjectRefs, otherRelevantRefs, groupRefs,
    async buildPrimaryIndex() {
      if (refs) return buildCompactEntityIndexAsync(deferPropertyAtomIndex ? refs.filter(ref => isPrimary(ref.type)) : refs);
      if (!deferPropertyAtomIndex || propertyAtomCount === 0) return compactEntityIndexFromColumns({
        ...columns!, typeIndices: columns!.typeIndices instanceof Uint16Array
          ? columns!.typeIndices : Uint16Array.from(columns!.typeIndices),
      });
      return selectEntityColumns(columns!, indexedCount, isPrimary);
    },
    async buildDeferredIndex() {
      if (!deferPropertyAtomIndex || propertyAtomCount === 0) return undefined;
      if (refs) return buildCompactEntityIndexAsync(propertyAtomRefs, undefined, 1024, 2);
      return selectEntityColumns(columns!, propertyAtomCount, undefined, deferredRows, 1024, 2);
    },
  };
}
