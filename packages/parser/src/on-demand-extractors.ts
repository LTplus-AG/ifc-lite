/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On-demand extraction functions for classifications, materials, documents,
 * georeferencing, relationships, and type properties.
 *
 * These functions parse data lazily from the IFC source buffer when accessed,
 * rather than pre-building all data upfront during initial parse.
 */

import { EntityExtractor } from './entity-extractor.js';
import { RelationshipType, resolvedTypeName } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { readQuantitySet, type CollectedQuantity } from './quantity-collect.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import type { GeoreferenceInfo } from './georef-extractor.js';
import { extractExactRelationshipEdges, type EntityRelationships } from './exact-relationship-edges.js';
export type { EntityRelationships } from './exact-relationship-edges.js';
export { extractExactRelatedIds } from './exact-relationship-edges.js';

// Re-export classification and material resolvers
export { extractClassificationsOnDemand, extractClassificationSystemsOnDemand } from './classification-resolver.js';
export type { ClassificationInfo, ClassificationSystemNames } from './classification-resolver.js';

export { extractMaterialsOnDemand, extractAllMaterialsOnDemand } from './material-resolver.js';
export type { MaterialInfo, MaterialLayerInfo, MaterialProfileInfo, MaterialConstituentInfo } from './material-resolver.js';

export {
    resolveMaterialDefId,
    resolveAllMaterialDefIds,
    collectMaterialLeaves,
    buildMaterialUsageIndex,
    getMaterialDisplay,
} from './material-resolver.js';
export type { MaterialLeaf, MaterialUsage } from './material-resolver.js';

// ============================================================================
// Remaining Interfaces
// ============================================================================

/**
 * Result of type-level property extraction.
 */
export interface TypePropertyInfo {
    typeName: string;
    typeId: number;
    properties: Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }>;
}

/**
 * Result of type-level quantity extraction (IfcElementQuantity sets on the
 * element's IfcTypeProduct, e.g. Qto_WallBaseQuantities defined once on
 * IfcWallType). Mirrors {@link TypePropertyInfo} for quantities.
 */
export interface TypeQuantityInfo {
    typeName: string;
    typeId: number;
    quantities: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }>;
}

export { extractDocumentsOnDemand, type DocumentInfo } from './document-resolver.js';

export type { GeoreferenceInfo as GeorefInfo };

// ============================================================================
// Property Value Parsing Helpers
// ============================================================================
//
// Moved to ./property-value-parser.ts to stay under the module-size budget;
// re-exported here so every existing import of this module keeps resolving.

export {
    parsePropertyValue,
    extractNumericValue,
    resolveComplexPropertyValue,
    parsePropertyValueWithComplex,
} from './property-value-parser.js';
import { copyParsedExtras, parsePropertyValueWithComplex, type ExtractedProperty } from './property-value-parser.js';
import { resolvePropertyUnit } from './property-unit.js';
// ============================================================================
// Property Set Extraction Helpers
// ============================================================================

/** Extract property sets from IDs, shared by instance- and type-level extraction. */
export function extractPsetsFromIds(
    store: IfcDataStore,
    extractor: EntityExtractor,
    psetIds: number[]
): Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }> {
    const result: Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }> = [];

    for (const psetId of psetIds) {
        // @raw-entity-enumeration-ok one requested set id is decoded from its source STEP span
        const psetRef = store.entityIndex.byId.get(psetId) ?? store.deferredEntityIndex?.get(psetId);
        if (!psetRef) continue;

        // Only extract IFCPROPERTYSET entities (skip quantity sets etc.)
        if (psetRef.type.toUpperCase() !== 'IFCPROPERTYSET') continue;

        const psetEntity = extractor.extractEntity(psetRef);
        if (!psetEntity) continue;

        const psetAttrs = psetEntity.attributes || [];
        const psetGlobalId = typeof psetAttrs[0] === 'string' ? psetAttrs[0] : undefined;
        const psetName = typeof psetAttrs[2] === 'string' ? psetAttrs[2] : ''; // not `PropertySet #<id>` (#3530)
        const hasProperties = psetAttrs[4];

        const properties: Array<ExtractedProperty> = [];

        if (Array.isArray(hasProperties)) {
            for (const propRef of hasProperties) {
                if (typeof propRef !== 'number') continue;

                // @raw-entity-enumeration-ok one referenced property id is decoded from its source STEP span
                const propEntityRef = store.entityIndex.byId.get(propRef) ?? store.deferredEntityIndex?.get(propRef);
                if (!propEntityRef) continue;

                const propEntity = extractor.extractEntity(propEntityRef);
                if (!propEntity) continue;

                const propAttrs = propEntity.attributes || [];
                const propName = typeof propAttrs[0] === 'string' ? propAttrs[0] : '';
                if (!propName) continue;

                const parsed = parsePropertyValueWithComplex(store, extractor, propEntity);
                const entry: ExtractedProperty = {
                    name: propName,
                    type: parsed.type,
                    value: parsed.value,
                };
                copyParsedExtras(entry, parsed);
                const unit = resolvePropertyUnit(store, extractor, propEntity.type, propAttrs, parsed.dataType);
                if (unit) entry.unit = unit.symbol;
                if (unit?.siScale !== undefined) entry.unitSiScale = unit.siScale;
                properties.push(entry);
            }
        }

        // Only surface sets that actually carry properties. An empty, named set
        // contributes nothing and — because extractTypePropertiesOnDemand dedups
        // by (name, globalId) identity — an empty set from one source could
        // otherwise suppress a populated same-identity set from another
        // (symmetric with extractQsetsFromIds).
        if (properties.length > 0) {
            result.push({ name: psetName, globalId: psetGlobalId, properties });
        }
    }

    return result;
}

// ============================================================================
// Type Property Extraction
// ============================================================================

/**
 * Extract type-level properties for a single entity ON-DEMAND.
 * Finds the element's type via IfcRelDefinesByType, then extracts property sets from:
 * 1. The type entity's HasPropertySets attribute (IFC2X3/IFC4: index 5 on IfcTypeObject)
 * 2. The onDemandPropertyMap for the type entity (IFC4 IFCRELDEFINESBYPROPERTIES → type)
 * Returns null if no type relationship exists.
 */
export function extractTypePropertiesOnDemand(
    store: IfcDataStore,
    entityId: number
): TypePropertyInfo | null {
    if (!store.relationships) return null;

    // Find type entity via DefinesByType relationship (inverse: element → type)
    const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
    if (typeIds.length === 0) return null;

    const typeId = typeIds[0]; // An element typically has one type
    // @raw-entity-enumeration-ok typeIds came from this selected entity's relationship lookup
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef) return null;

    if (!store.source?.length) return null;

    const extractor = new EntityExtractor(store.source);

    // Get type name from entity
    const typeEntity = extractor.extractEntity(typeRef);
    const typeName = typeEntity && typeof typeEntity.attributes?.[2] === 'string'
        ? typeEntity.attributes[2]
        : typeRef.type;

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }> = [];
    const seenPsetKeys = new Set<string>();
    const ownPsetIds = new Set<number>();

    // Source 1: HasPropertySets attribute on the type entity (index 5 for IfcTypeObject subtypes)
    // Works for both IFC2X3 and IFC4
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            for (const id of hasPropertySets) if (typeof id === 'number') ownPsetIds.add(id);
            for (const pset of extractPsetsFromIds(store, extractor, [...ownPsetIds])) {
                seenPsetKeys.add(setIdentityKey(pset));
                allPsets.push(pset);
            }
        }
    }

    // Source 2: onDemandPropertyMap for the type entity (IFC4: via IFCRELDEFINESBYPROPERTIES)
    const typePsetIds = store.onDemandPropertyMap?.get(typeId);
    if (typePsetIds && typePsetIds.length > 0) {
        appendSetsFromSecondSource(allPsets, ownPsetIds, seenPsetKeys, typePsetIds,
            (ids) => extractPsetsFromIds(store, extractor, ids));
    }

    if (allPsets.length === 0) return null;

    return {
        typeName,
        typeId,
        properties: allPsets,
    };
}


/**
 * Extract properties from a type entity's own HasPropertySets attribute.
 * Used when the type entity itself is selected (e.g., via "By Type" tree).
 * Returns the type's own property sets from attribute index 5 + any via IfcRelDefinesByProperties.
 */
export function extractTypeEntityOwnProperties(
    store: IfcDataStore,
    typeEntityId: number
): Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }> {
    // @raw-entity-enumeration-ok the caller selected this one source type entity by id
    const ref = store.entityIndex.byId.get(typeEntityId);
    if (!ref || !store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const typeEntity = extractor.extractEntity(ref);
    if (!typeEntity) return [];

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<ExtractedProperty> }> = [];
    const seenPsetKeys = new Set<string>();
    const ownPsetIds = new Set<number>();

    // Source 1: HasPropertySets attribute (index 5 for IfcTypeObject subtypes)
    const hasPropertySets = typeEntity.attributes?.[5];
    if (Array.isArray(hasPropertySets)) {
        for (const id of hasPropertySets) if (typeof id === 'number') ownPsetIds.add(id);
        for (const pset of extractPsetsFromIds(store, extractor, [...ownPsetIds])) {
            seenPsetKeys.add(setIdentityKey(pset));
            allPsets.push(pset);
        }
    }

    // Source 2: onDemandPropertyMap (IFC4: via IFCRELDEFINESBYPROPERTIES)
    const typePsetIds = store.onDemandPropertyMap?.get(typeEntityId);
    if (typePsetIds && typePsetIds.length > 0) {
        appendSetsFromSecondSource(allPsets, ownPsetIds, seenPsetKeys, typePsetIds,
            (ids) => extractPsetsFromIds(store, extractor, ids));
    }

    return allPsets;
}

// ============================================================================
// Type Quantity Extraction
// ============================================================================

/**
 * Extract quantity sets (IfcElementQuantity) from a list of set IDs using the
 * entity index. The quantity counterpart of {@link extractPsetsFromIds}: it
 * skips anything that is not an IFCELEMENTQUANTITY (e.g. property sets that
 * share the HasPropertySets list on a type).
 */
export function extractQsetsFromIds(
    store: IfcDataStore,
    extractor: EntityExtractor,
    qsetIds: number[]
): Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> {
    const result: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> = [];

    for (const qsetId of qsetIds) {
        // @raw-entity-enumeration-ok one requested quantity-set id is decoded from its source STEP span
        const qsetRef = store.entityIndex.byId.get(qsetId);
        if (!qsetRef) continue;

        // Only extract IFCELEMENTQUANTITY entities (skip property sets etc.)
        if (qsetRef.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;

        // A set that walks to zero quantities is dropped — see
        // {@link readQuantitySet}. Here that also stops an empty set from one
        // source suppressing a populated same-identity set from another, since
        // `extractTypeQuantitiesOnDemand` still dedups NAMED sets by
        // `(name, globalId)` identity (see {@link appendSetsFromSecondSource}).
        const qset = readQuantitySet(store, extractor, qsetRef);
        if (qset) result.push(qset);
    }

    return result;
}

/**
 * Extract type-level quantities for a single entity ON-DEMAND.
 * Finds the element's type via IfcRelDefinesByType, then extracts element
 * quantities from:
 * 1. The type entity's HasPropertySets attribute (index 5 on IfcTypeObject) —
 *    an IfcPropertySetDefinition list that may include IfcElementQuantity.
 * 2. The onDemandQuantityMap for the type entity (IFC4 IfcRelDefinesByProperties
 *    with an IfcElementQuantity targeting the type).
 * Returns null when the element has no type or the type carries no quantities.
 * The quantity counterpart of {@link extractTypePropertiesOnDemand}.
 */
export function extractTypeQuantitiesOnDemand(
    store: IfcDataStore,
    entityId: number
): TypeQuantityInfo | null {
    if (!store.relationships) return null;

    const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
    if (typeIds.length === 0) return null;

    const typeId = typeIds[0];
    // @raw-entity-enumeration-ok typeIds came from this selected entity's relationship lookup
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef) return null;

    if (!store.source?.length) return null;

    const extractor = new EntityExtractor(store.source);

    const typeEntity = extractor.extractEntity(typeRef);
    const typeName = typeEntity && typeof typeEntity.attributes?.[2] === 'string'
        ? typeEntity.attributes[2]
        : typeRef.type;

    const allQsets: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> = [];
    const seenQsetKeys = new Set<string>();
    const ownSetIds = new Set<number>();

    // Source 1: HasPropertySets attribute on the type (index 5) — quantity sets
    // live alongside property sets in this IfcPropertySetDefinition list.
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            for (const id of hasPropertySets) if (typeof id === 'number') ownSetIds.add(id);
            for (const qset of extractQsetsFromIds(store, extractor, [...ownSetIds])) {
                seenQsetKeys.add(setIdentityKey(qset));
                allQsets.push(qset);
            }
        }
    }

    // Source 2: onDemandQuantityMap for the type entity (IFC4 IfcRelDefinesByProperties).
    const typeQsetIds = store.onDemandQuantityMap?.get(typeId);
    if (typeQsetIds && typeQsetIds.length > 0) {
        appendSetsFromSecondSource(allQsets, ownSetIds, seenQsetKeys, typeQsetIds,
            (ids) => extractQsetsFromIds(store, extractor, ids));
    }

    if (allQsets.length === 0) return null;

    return { typeName, typeId, quantities: allQsets };
}

// ============================================================================
// Document Extraction
// ============================================================================

/**
 * Extract documents for a single entity ON-DEMAND.
 * Uses the onDemandDocumentMap built during parsing.
 * Falls back to relationship graph when on-demand map is not available.
 * Also checks type-level documents via IfcRelDefinesByType.
 * Returns an array of document info objects.
 */
// ============================================================================
// Relationship Extraction
// ============================================================================

/**
 * Extract structural relationships for a single entity ON-DEMAND.
 * Finds openings (VoidsElement), fills (FillsElement), groups (AssignsToGroup),
 * and path connections (ConnectsPathElements).
 */
export function extractRelationshipsOnDemand(
    store: IfcDataStore,
    entityId: number
): EntityRelationships {
    const result: EntityRelationships = {
        voids: [],
        fills: [],
        groups: [],
        connections: [],
        relations: [],
    };

    if (!store.relationships) return result;
    result.relations = extractExactRelationshipEdges(store, entityId);

    const getEntityInfo = (id: number): { name?: string; type: string } => {
        // @raw-entity-enumeration-ok graph already selected this related id; source index supplies its STEP class only
        const ref = store.entityIndex.byId.get(id);
        // Canonical IfcPascalCase (e.g. "IfcZone") for display + case-sensitive
        // consumers; `ref.type` is the raw STEP token ("IFCZONE"). Groups now
        // live in the EntityTable so getTypeName resolves them too. (#1075)
        // IFCX stores ingest with an EMPTY entityIndex.byId (no STEP byte
        // spans exist), so when byId misses the EntityTable is the authority
        // for name/type instead of reporting Unknown (#1622 IFCX follow-up).
        const tableType = store.entities && resolvedTypeName(store.entities, id);
        if (!ref && !tableType) return { type: 'Unknown' };
        const name = store.entities?.getName(id);
        const type = tableType || ref?.type || 'Unknown';
        return { name: name || undefined, type };
    };

    // VoidsElement: openings that void this element
    const voidsIds = store.relationships.getRelated(entityId, RelationshipType.VoidsElement, 'forward');
    for (const id of voidsIds) {
        const info = getEntityInfo(id);
        result.voids.push({ id, ...info });
    }

    // FillsElement: this element fills an opening
    const fillsIds = store.relationships.getRelated(entityId, RelationshipType.FillsElement, 'inverse');
    for (const id of fillsIds) {
        const info = getEntityInfo(id);
        result.fills.push({ id, ...info });
    }

    // AssignsToGroup: groups (IfcZone / IfcGroup / IfcSystem) this element belongs to
    const groupIds = store.relationships.getRelated(entityId, RelationshipType.AssignsToGroup, 'inverse');
    for (const id of groupIds) {
        const info = getEntityInfo(id);
        result.groups.push({ id, ...info });
    }

    // ConnectsPathElements: connected walls
    const connectedIds = store.relationships.getRelated(entityId, RelationshipType.ConnectsPathElements, 'forward');
    const connectedInverseIds = store.relationships.getRelated(entityId, RelationshipType.ConnectsPathElements, 'inverse');
    const allConnected = new Set([...connectedIds, ...connectedInverseIds]);
    allConnected.delete(entityId);
    for (const id of allConnected) {
        const info = getEntityInfo(id);
        result.connections.push({ id, ...info });
    }

    return result;
}

/** A member object of an IfcZone / IfcGroup (the RelatedObjects of its
 *  IfcRelAssignsToGroup). */
export interface GroupMember {
    id: number;
    name?: string;
    type: string;
}

/**
 * Enumerate the member objects of a group/zone ON-DEMAND — the inverse of the
 * `groups` field in {@link extractRelationshipsOnDemand}. Resolves the
 * RelatedObjects of the group's IfcRelAssignsToGroup (forward direction:
 * group → members). For an IfcZone this returns the IfcSpace / IfcSpatialZone
 * members so the UI can select/isolate everything in a dwelling, house number,
 * fire compartment, etc. (#1075).
 */
export function extractGroupMembersOnDemand(
    store: IfcDataStore,
    groupId: number
): GroupMember[] {
    if (!store.relationships) return [];
    const memberIds = store.relationships.getRelated(groupId, RelationshipType.AssignsToGroup, 'forward');
    const members: GroupMember[] = [];
    for (const id of memberIds) {
        // @raw-entity-enumeration-ok graph already selected this group member id; source index supplies its STEP class only
        const ref = store.entityIndex.byId.get(id);
        // Canonical IfcPascalCase (e.g. "IfcSpace") — `ref.type` is the raw STEP
        // token ("IFCSPACE"), which would break case-sensitive class checks in
        // consumers (member-isolation toggles, lens zone matching). (#1075)
        const tableType = store.entities && resolvedTypeName(store.entities, id);
        // IFCX stores ingest with an EMPTY entityIndex.byId (no STEP byte spans
        // exist), so existence rides the EntityTable there: keep a member when
        // EITHER source knows the id. STEP stores keep byId as the primary gate
        // and resolve identically to before (#1622 IFCX follow-up).
        if (!ref && !tableType) continue;
        const name = store.entities?.getName(id);
        const type = tableType || ref?.type || 'Unknown';
        members.push({ id, name: name || undefined, type });
    }
    return members;
}

export { extractGroupAssignmentFactorOnDemand } from './group-assignment-factor.js'; // moved out

// ============================================================================
// On-Demand Georeferencing Extraction
// ============================================================================

// The per-store memo now lives in ./on-demand-cache.ts (import it there for
// any new extract*OnDemand) and the georeferencing extractor in
// ./on-demand-georeferencing.ts, re-exported here so every existing import
// of this module keeps resolving.
export { extractGeoreferencingOnDemand } from './on-demand-georeferencing.js';

// Material property sets are isolated here because their reverse index is a
// separate concern from the other on-demand entity extractors.
export { extractMaterialPropertiesOnDemand, extractMaterialPropertiesForMaterialId } from './material-properties-extractor.js';
export type { MaterialPropertiesView, MaterialPsetGroup } from './material-properties-extractor.js';
