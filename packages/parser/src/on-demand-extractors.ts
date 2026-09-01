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
import {
    RelationshipType,
} from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { readQuantitySet } from './quantity-collect.js';
import { appendSetsFromSecondSource } from './property-set-merge.js';
import type { GeoreferenceInfo } from './georef-extractor.js';

// Re-export classification and material resolvers
export { extractClassificationsOnDemand, extractClassificationSystemsOnDemand } from './classification-resolver.js';
export type { ClassificationInfo } from './classification-resolver.js';

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

import {
    resolveAllMaterialDefIds as resolveAllMaterialDefIdsImpl,
    collectMaterialLeaves as collectMaterialLeavesImpl,
    getMaterialDisplay as getMaterialDisplayImpl,
} from './material-resolver.js';

// ============================================================================
// Remaining Interfaces
// ============================================================================

/**
 * Result of type-level property extraction.
 */
export interface TypePropertyInfo {
    typeName: string;
    typeId: number;
    properties: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }>;
}

/**
 * Result of type-level quantity extraction (IfcElementQuantity sets on the
 * element's IfcTypeProduct, e.g. Qto_WallBaseQuantities defined once on
 * IfcWallType). Mirrors {@link TypePropertyInfo} for quantities.
 */
export interface TypeQuantityInfo {
    typeName: string;
    typeId: number;
    quantities: Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }>;
}

/**
 * Structured document info from IFC document references.
 */
export interface DocumentInfo {
    name?: string;
    description?: string;
    location?: string;
    identification?: string;
    purpose?: string;
    intendedUse?: string;
    revision?: string;
    confidentiality?: string;
}

/**
 * Structured relationship info for an entity.
 */
export interface EntityRelationships {
    voids: Array<{ id: number; name?: string; type: string }>;
    fills: Array<{ id: number; name?: string; type: string }>;
    /** Groups this entity is assigned to (IfcZone, IfcGroup, IfcSystem, …) via
     *  IfcRelAssignsToGroup. `type` distinguishes IfcZone from a plain IfcGroup. */
    groups: Array<{ id: number; name?: string; type: string }>;
    connections: Array<{ id: number; name?: string; type: string }>;
}

export type { GeoreferenceInfo as GeorefInfo };

/**
 * Property sets attached to a material via IfcMaterialProperties (e.g.
 * Pset_MaterialConcrete). Grouped per underlying IfcMaterial so the UI can
 * show which material each set belongs to. See {@link extractMaterialPropertiesOnDemand}.
 */
export interface MaterialPsetGroup {
    materialId: number;
    materialName: string;
    psets: Array<{ name: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }>;
}

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
import { parsePropertyValueWithComplex } from './property-value-parser.js';


// ============================================================================
// Property Set Extraction Helpers
// ============================================================================

/**
 * Extract property sets from a list of pset IDs using the entity index.
 * Shared logic between instance-level and type-level property extraction.
 */
export function extractPsetsFromIds(
    store: IfcDataStore,
    extractor: EntityExtractor,
    psetIds: number[]
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> {
    const result: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> = [];

    for (const psetId of psetIds) {
        const psetRef = store.entityIndex.byId.get(psetId);
        if (!psetRef) continue;

        // Only extract IFCPROPERTYSET entities (skip quantity sets etc.)
        if (psetRef.type.toUpperCase() !== 'IFCPROPERTYSET') continue;

        const psetEntity = extractor.extractEntity(psetRef);
        if (!psetEntity) continue;

        const psetAttrs = psetEntity.attributes || [];
        const psetGlobalId = typeof psetAttrs[0] === 'string' ? psetAttrs[0] : undefined;
        const psetName = typeof psetAttrs[2] === 'string' ? psetAttrs[2] : ''; // not `PropertySet #<id>` (#3530)
        const hasProperties = psetAttrs[4];

        const properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> = [];

        if (Array.isArray(hasProperties)) {
            for (const propRef of hasProperties) {
                if (typeof propRef !== 'number') continue;

                const propEntityRef = store.entityIndex.byId.get(propRef);
                if (!propEntityRef) continue;

                const propEntity = extractor.extractEntity(propEntityRef);
                if (!propEntity) continue;

                const propAttrs = propEntity.attributes || [];
                const propName = typeof propAttrs[0] === 'string' ? propAttrs[0] : '';
                if (!propName) continue;

                const parsed = parsePropertyValueWithComplex(store, extractor, propEntity);
                const entry: { name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string } = {
                    name: propName,
                    type: parsed.type,
                    value: parsed.value,
                };
                if (parsed.values) entry.values = parsed.values;
                if (parsed.dataType) entry.dataType = parsed.dataType;
                properties.push(entry);
            }
        }

        // Only surface sets that actually carry properties. An empty, named set
        // contributes nothing and — because extractTypePropertiesOnDemand dedups
        // by name — an empty set from one source could otherwise suppress a
        // populated same-named set from another (symmetric with extractQsetsFromIds).
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
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef) return null;

    if (!store.source?.length) return null;

    const extractor = new EntityExtractor(store.source);

    // Get type name from entity
    const typeEntity = extractor.extractEntity(typeRef);
    const typeName = typeEntity && typeof typeEntity.attributes?.[2] === 'string'
        ? typeEntity.attributes[2]
        : typeRef.type;

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[] }> }> = [];
    const seenPsetNames = new Set<string>();
    const ownPsetIds = new Set<number>();

    // Source 1: HasPropertySets attribute on the type entity (index 5 for IfcTypeObject subtypes)
    // Works for both IFC2X3 and IFC4
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            for (const id of hasPropertySets) if (typeof id === 'number') ownPsetIds.add(id);
            for (const pset of extractPsetsFromIds(store, extractor, [...ownPsetIds])) {
                seenPsetNames.add(pset.name);
                allPsets.push(pset);
            }
        }
    }

    // Source 2: onDemandPropertyMap for the type entity (IFC4: via IFCRELDEFINESBYPROPERTIES)
    const typePsetIds = store.onDemandPropertyMap?.get(typeId);
    if (typePsetIds && typePsetIds.length > 0) {
        appendSetsFromSecondSource(allPsets, ownPsetIds, seenPsetNames, typePsetIds,
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
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> {
    const ref = store.entityIndex.byId.get(typeEntityId);
    if (!ref || !store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const typeEntity = extractor.extractEntity(ref);
    if (!typeEntity) return [];

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> = [];
    const seenPsetNames = new Set<string>();
    const ownPsetIds = new Set<number>();

    // Source 1: HasPropertySets attribute (index 5 for IfcTypeObject subtypes)
    const hasPropertySets = typeEntity.attributes?.[5];
    if (Array.isArray(hasPropertySets)) {
        for (const id of hasPropertySets) if (typeof id === 'number') ownPsetIds.add(id);
        for (const pset of extractPsetsFromIds(store, extractor, [...ownPsetIds])) {
            seenPsetNames.add(pset.name);
            allPsets.push(pset);
        }
    }

    // Source 2: onDemandPropertyMap (IFC4: via IFCRELDEFINESBYPROPERTIES)
    const typePsetIds = store.onDemandPropertyMap?.get(typeEntityId);
    if (typePsetIds && typePsetIds.length > 0) {
        appendSetsFromSecondSource(allPsets, ownPsetIds, seenPsetNames, typePsetIds,
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
): Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> {
    const result: Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> = [];

    for (const qsetId of qsetIds) {
        const qsetRef = store.entityIndex.byId.get(qsetId);
        if (!qsetRef) continue;

        // Only extract IFCELEMENTQUANTITY entities (skip property sets etc.)
        if (qsetRef.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;

        // A set that walks to zero quantities is dropped — see
        // {@link readQuantitySet}. Here that also stops an empty set from one
        // source suppressing a populated same-named set from another, since
        // `extractTypeQuantitiesOnDemand` still dedups NAMED sets by name (see
        // {@link appendSetsFromSecondSource}).
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
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef) return null;

    if (!store.source?.length) return null;

    const extractor = new EntityExtractor(store.source);

    const typeEntity = extractor.extractEntity(typeRef);
    const typeName = typeEntity && typeof typeEntity.attributes?.[2] === 'string'
        ? typeEntity.attributes[2]
        : typeRef.type;

    const allQsets: Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> = [];
    const seenQsetNames = new Set<string>();
    const ownSetIds = new Set<number>();

    // Source 1: HasPropertySets attribute on the type (index 5) — quantity sets
    // live alongside property sets in this IfcPropertySetDefinition list.
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            for (const id of hasPropertySets) if (typeof id === 'number') ownSetIds.add(id);
            for (const qset of extractQsetsFromIds(store, extractor, [...ownSetIds])) {
                seenQsetNames.add(qset.name);
                allQsets.push(qset);
            }
        }
    }

    // Source 2: onDemandQuantityMap for the type entity (IFC4 IfcRelDefinesByProperties).
    const typeQsetIds = store.onDemandQuantityMap?.get(typeId);
    if (typeQsetIds && typeQsetIds.length > 0) {
        appendSetsFromSecondSource(allQsets, ownSetIds, seenQsetNames, typeQsetIds,
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
export function extractDocumentsOnDemand(
    store: IfcDataStore,
    entityId: number
): DocumentInfo[] {
    let docRefIds: number[] | undefined;

    if (store.onDemandDocumentMap) {
        docRefIds = store.onDemandDocumentMap.get(entityId);
    } else if (store.relationships) {
        const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesDocument, 'inverse');
        if (related.length > 0) docRefIds = related;
    }

    // Also check type-level documents via IfcRelDefinesByType
    if (store.relationships) {
        const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
        for (const typeId of typeIds) {
            let typeDocRefs: number[] | undefined;
            if (store.onDemandDocumentMap) {
                typeDocRefs = store.onDemandDocumentMap.get(typeId);
            } else {
                const related = store.relationships.getRelated(typeId, RelationshipType.AssociatesDocument, 'inverse');
                if (related.length > 0) typeDocRefs = related;
            }
            if (typeDocRefs && typeDocRefs.length > 0) {
                docRefIds = docRefIds ? [...docRefIds, ...typeDocRefs] : [...typeDocRefs];
            }
        }
    }

    if (!docRefIds || docRefIds.length === 0) return [];
    if (!store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const results: DocumentInfo[] = [];

    for (const docId of docRefIds) {
        const docRef = store.entityIndex.byId.get(docId);
        if (!docRef) continue;

        const docEntity = extractor.extractEntity(docRef);
        if (!docEntity) continue;

        const typeUpper = docEntity.type.toUpperCase();
        const attrs = docEntity.attributes || [];

        if (typeUpper === 'IFCDOCUMENTREFERENCE') {
            // IFC4: [Location, Identification, Name, Description, ReferencedDocument]
            // IFC2X3: [Location, ItemReference, Name]
            const info: DocumentInfo = {
                location: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                identification: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                name: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                description: typeof attrs[3] === 'string' ? attrs[3] : undefined,
            };

            // Walk to IfcDocumentInformation if ReferencedDocument is set (IFC4 attr[4])
            if (typeof attrs[4] === 'number') {
                const docInfoRef = store.entityIndex.byId.get(attrs[4]);
                if (docInfoRef) {
                    const docInfoEntity = extractor.extractEntity(docInfoRef);
                    if (docInfoEntity && docInfoEntity.type.toUpperCase() === 'IFCDOCUMENTINFORMATION') {
                        const ia = docInfoEntity.attributes || [];
                        // IfcDocumentInformation: [Identification, Name, Description, Location, Purpose, IntendedUse, Scope, Revision, ...]
                        if (!info.identification && typeof ia[0] === 'string') info.identification = ia[0];
                        if (!info.name && typeof ia[1] === 'string') info.name = ia[1];
                        if (!info.description && typeof ia[2] === 'string') info.description = ia[2];
                        if (!info.location && typeof ia[3] === 'string') info.location = ia[3];
                        if (typeof ia[4] === 'string') info.purpose = ia[4];
                        if (typeof ia[5] === 'string') info.intendedUse = ia[5];
                        if (typeof ia[7] === 'string') info.revision = ia[7];
                    }
                }
            }

            if (info.name || info.location || info.identification) {
                results.push(info);
            }
        } else if (typeUpper === 'IFCDOCUMENTINFORMATION') {
            // Direct IfcDocumentInformation (less common)
            const info: DocumentInfo = {
                identification: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                name: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                description: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                location: typeof attrs[3] === 'string' ? attrs[3] : undefined,
                purpose: typeof attrs[4] === 'string' ? attrs[4] : undefined,
                intendedUse: typeof attrs[5] === 'string' ? attrs[5] : undefined,
                revision: typeof attrs[7] === 'string' ? attrs[7] : undefined,
            };

            if (info.name || info.location || info.identification) {
                results.push(info);
            }
        }
    }

    return results;
}

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
    };

    if (!store.relationships) return result;

    const getEntityInfo = (id: number): { name?: string; type: string } => {
        const ref = store.entityIndex.byId.get(id);
        // Canonical IfcPascalCase (e.g. "IfcZone") for display + case-sensitive
        // consumers; `ref.type` is the raw STEP token ("IFCZONE"). Groups now
        // live in the EntityTable so getTypeName resolves them too. (#1075)
        // IFCX stores ingest with an EMPTY entityIndex.byId (no STEP byte
        // spans exist), so when byId misses the EntityTable is the authority
        // for name/type instead of reporting Unknown (#1622 IFCX follow-up).
        const tableType = store.entities?.getTypeName?.(id);
        if (!ref && (!tableType || tableType === 'Unknown')) return { type: 'Unknown' };
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
        const ref = store.entityIndex.byId.get(id);
        // Canonical IfcPascalCase (e.g. "IfcSpace") — `ref.type` is the raw STEP
        // token ("IFCSPACE"), which would break case-sensitive class checks in
        // consumers (member-isolation toggles, lens zone matching). (#1075)
        const tableType = store.entities?.getTypeName(id);
        // IFCX stores ingest with an EMPTY entityIndex.byId (no STEP byte spans
        // exist), so existence rides the EntityTable there: keep a member when
        // EITHER source knows the id. STEP stores keep byId as the primary gate
        // and resolve identically to before (#1622 IFCX follow-up).
        if (!ref && (!tableType || tableType === 'Unknown')) continue;
        const name = store.entities?.getName(id);
        const type = tableType || ref?.type || 'Unknown';
        members.push({ id, name: name || undefined, type });
    }
    return members;
}

// ============================================================================
// On-Demand Georeferencing Extraction
// ============================================================================

// The per-store memo now lives in ./on-demand-cache.ts (import it there for
// any new extract*OnDemand) and the georeferencing extractor in
// ./on-demand-georeferencing.ts, re-exported here so every existing import
// of this module keeps resolving.
export { extractGeoreferencingOnDemand } from './on-demand-georeferencing.js';

// ============================================================================
// Material Property Set Extraction (issue #978)
//
// Material psets are attached to an IfcMaterial via IfcMaterialProperties
// (the material's `Material` attribute points back to the material), NOT via
// IfcRelDefinesByProperties — so they never appear in `onDemandPropertyMap`.
// We build a reverse index (materialId -> material psets) by scanning every
// *MaterialProperties entity once, then resolve it for the selected element's
// underlying materials.
// ============================================================================

interface MaterialPsetEntry { name: string; properties: MaterialPsetGroup['psets'][number]['properties'] }

const materialPropertyIndexCache = new WeakMap<IfcDataStore, Map<number, MaterialPsetEntry[]>>();

/** Resolve an entity ref from the primary index, falling back to deferred atoms. */
function refFromStore(store: IfcDataStore, id: number) {
    return store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
}

/**
 * Resolve the (materialId, propsList, psetName) triple for a *MaterialProperties
 * entity, dispatching on its concrete class rather than guessing attribute
 * positions. The two generic forms that carry an IfcProperty list are handled:
 *   - IfcMaterialProperties      (IFC4+):  [Name, Description, Properties, Material]
 *   - IfcExtendedMaterialProperties (IFC2x3): [Material, ExtendedProperties, Description, Name]
 * The typed IFC2x3 subtypes (IfcMechanicalMaterialProperties, IfcThermalMaterialProperties,
 * …) expose domain-specific scalar fields instead of a generic property list and
 * are not surfaced (returns null) — they are not the Pset_Material* this targets.
 */
function readMaterialPropsEntity(
    typeKey: string,
    attrs: readonly unknown[],
    entityType: string,
): { materialId: number; propsList: unknown[]; psetName: string } | null {
    let materialId: unknown;
    let propsList: unknown;
    let name: unknown;

    if (typeKey === 'IFCMATERIALPROPERTIES') {
        name = attrs[0]; propsList = attrs[2]; materialId = attrs[3];
    } else if (typeKey === 'IFCEXTENDEDMATERIALPROPERTIES') {
        materialId = attrs[0]; propsList = attrs[1]; name = attrs[3];
    } else {
        return null; // typed IFC2x3 scalar subtype — no generic property list
    }

    if (typeof materialId !== 'number' || !Array.isArray(propsList)) return null;
    const psetName = typeof name === 'string' && name ? name : (entityType || 'Material Properties');
    return { materialId, propsList, psetName };
}

/**
 * Build (and memoise) the model-wide map of materialId -> property sets defined
 * via IfcMaterialProperties / IfcExtendedMaterialProperties. These reference the
 * material directly (not through IfcRelDefinesByProperties), so they are found by
 * scanning every *MaterialProperties entity once.
 */
function getMaterialPropertyIndex(store: IfcDataStore): Map<number, MaterialPsetEntry[]> {
    const cached = materialPropertyIndexCache.get(store);
    if (cached) return cached;

    const index = new Map<number, MaterialPsetEntry[]>();
    if (!store.source?.length || !store.entityIndex?.byType) {
        materialPropertyIndexCache.set(store, index);
        return index;
    }

    const extractor = new EntityExtractor(store.source);

    for (const [typeKey, ids] of store.entityIndex.byType) {
        if (!typeKey.endsWith('MATERIALPROPERTIES')) continue;
        for (const matPropsId of ids) {
            const ref = refFromStore(store, matPropsId);
            if (!ref) continue;
            const entity = extractor.extractEntity(ref);
            const attrs = entity?.attributes;
            if (!attrs) continue;

            const parsed = readMaterialPropsEntity(typeKey, attrs, entity!.type);
            if (!parsed) continue;

            const properties: MaterialPsetEntry['properties'] = [];
            for (const propRef of parsed.propsList) {
                if (typeof propRef !== 'number') continue;
                const propEntityRef = refFromStore(store, propRef);
                if (!propEntityRef) continue;
                const propEntity = extractor.extractEntity(propEntityRef);
                if (!propEntity) continue;
                const propAttrs = propEntity.attributes || [];
                const propName = typeof propAttrs[0] === 'string' ? propAttrs[0] : '';
                if (!propName) continue;
                const pv = parsePropertyValueWithComplex(store, extractor, propEntity);
                const entry: MaterialPsetEntry['properties'][number] = {
                    name: propName,
                    type: pv.type,
                    value: pv.value,
                };
                if (pv.values) entry.values = pv.values;
                if (pv.dataType) entry.dataType = pv.dataType;
                properties.push(entry);
            }
            if (properties.length === 0) continue;

            let list = index.get(parsed.materialId);
            if (!list) { list = []; index.set(parsed.materialId, list); }
            list.push({ name: parsed.psetName, properties });
        }
    }

    materialPropertyIndexCache.set(store, index);
    return index;
}

/** Build pset groups for a set of candidate material ids using the reverse index. */
function buildMaterialPsetGroups(store: IfcDataStore, materialIds: number[]): MaterialPsetGroup[] {
    const index = getMaterialPropertyIndex(store);
    if (index.size === 0) return [];

    const groups: MaterialPsetGroup[] = [];
    const seen = new Set<number>();
    for (const matId of materialIds) {
        if (seen.has(matId)) continue;
        seen.add(matId);
        const entries = index.get(matId);
        if (!entries || entries.length === 0) continue;
        const { name } = getMaterialDisplayImpl(store, matId);
        groups.push({
            materialId: matId,
            materialName: name,
            psets: entries.map((e) => ({ name: e.name, properties: e.properties })),
        });
    }
    return groups;
}

/**
 * Material property sets associated with a selected element, resolved through
 * its material association. Fans out a layer/profile/constituent set to its
 * member IfcMaterials (where Pset_Material* typically lives) and also checks
 * the set definition itself. Returns one group per material that has psets.
 */
export function extractMaterialPropertiesOnDemand(store: IfcDataStore, entityId: number): MaterialPsetGroup[] {
    // Every association, not just the primary — psets on a second
    // IfcRelAssociatesMaterial's definition were previously invisible.
    const defIds = resolveAllMaterialDefIdsImpl(store, entityId);
    if (defIds.length === 0) return [];
    const ids: number[] = [];
    for (const defId of defIds) {
        ids.push(defId, ...collectMaterialLeavesImpl(store, defId).map((l) => l.id));
    }
    return buildMaterialPsetGroups(store, ids);
}

/**
 * Material property sets for a directly-selected material entity (the Materials
 * hierarchy tab). Includes the material's own psets plus, when it is a set
 * definition, those of its member materials.
 */
export function extractMaterialPropertiesForMaterialId(store: IfcDataStore, materialId: number): MaterialPsetGroup[] {
    const leafIds = collectMaterialLeavesImpl(store, materialId).map((l) => l.id);
    return buildMaterialPsetGroups(store, [materialId, ...leafIds]);
}
