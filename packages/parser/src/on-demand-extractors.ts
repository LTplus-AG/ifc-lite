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

import type { IfcEntity } from './types.js';
import { EntityExtractor } from './entity-extractor.js';
import {
    RelationshipType,
    PropertyValueType,
} from '@ifc-lite/data';
import type { PropertyValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractGeoreferencing as extractGeorefFromEntities, type GeoreferenceInfo } from './georef-extractor.js';

// Re-export classification and material resolvers
export { extractClassificationsOnDemand } from './classification-resolver.js';
export type { ClassificationInfo } from './classification-resolver.js';

export { extractMaterialsOnDemand } from './material-resolver.js';
export type { MaterialInfo, MaterialLayerInfo, MaterialProfileInfo, MaterialConstituentInfo } from './material-resolver.js';

// ============================================================================
// Remaining Interfaces
// ============================================================================

/**
 * Result of type-level property extraction.
 */
export interface TypePropertyInfo {
    typeName: string;
    typeId: number;
    properties: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }>;
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
    groups: Array<{ id: number; name?: string }>;
    connections: Array<{ id: number; name?: string; type: string }>;
}

export type { GeoreferenceInfo as GeorefInfo };

// ============================================================================
// Property Value Parsing Helpers
// ============================================================================

/**
 * Parse a property entity's value based on its IFC type.
 * Handles all 6 IfcProperty subtypes:
 * - IfcPropertySingleValue: direct value
 * - IfcPropertyEnumeratedValue: list of enum values → joined string
 * - IfcPropertyBoundedValue: upper/lower bounds → "value [min – max]"
 * - IfcPropertyListValue: list of values → joined string
 * - IfcPropertyTableValue: defining/defined value pairs → "Table(N rows)"
 * - IfcPropertyReferenceValue: entity reference → "Reference #ID"
 */
export function parsePropertyValue(propEntity: IfcEntity): { type: number; value: PropertyValue } {
    const attrs = propEntity.attributes || [];
    const typeUpper = propEntity.type.toUpperCase();

    switch (typeUpper) {
        case 'IFCPROPERTYENUMERATEDVALUE': {
            // [Name, Description, EnumerationValues (list), EnumerationReference]
            const enumValues = attrs[2];
            if (Array.isArray(enumValues)) {
                const values = enumValues.map(v => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]); // Typed value
                    return String(v);
                }).filter(v => v !== 'null' && v !== 'undefined');
                return { type: 0, value: values.join(', ') };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYBOUNDEDVALUE': {
            // [Name, Description, UpperBoundValue, LowerBoundValue, Unit, SetPointValue]
            const upper = extractNumericValue(attrs[2]);
            const lower = extractNumericValue(attrs[3]);
            const setPoint = extractNumericValue(attrs[5]);
            const displayValue = setPoint ?? upper ?? lower;
            let display = displayValue != null ? String(displayValue) : '';
            if (lower != null && upper != null) {
                display += ` [${lower} – ${upper}]`;
            }
            return { type: displayValue != null ? 1 : 0, value: display || null };
        }

        case 'IFCPROPERTYLISTVALUE': {
            // [Name, Description, ListValues (list), Unit]
            const listValues = attrs[2];
            if (Array.isArray(listValues)) {
                const values = listValues.map(v => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]);
                    return String(v);
                }).filter(v => v !== 'null' && v !== 'undefined');
                return { type: 0, value: values.join(', ') };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYTABLEVALUE': {
            // [Name, Description, DefiningValues, DefinedValues, ...]
            const definingValues = attrs[2];
            const definedValues = attrs[3];
            const rowCount = Array.isArray(definingValues) ? definingValues.length : 0;
            if (rowCount > 0 && Array.isArray(definedValues)) {
                return { type: 0, value: `Table (${rowCount} rows)` };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYREFERENCEVALUE': {
            // [Name, Description, PropertyReference]
            const refValue = attrs[2];
            if (typeof refValue === 'number') {
                return { type: 0, value: `#${refValue}` };
            }
            return { type: 0, value: null };
        }

        default: {
            // IfcPropertySingleValue and fallback: [Name, Description, NominalValue, Unit]
            const nominalValue = attrs[2];
            let type: number = PropertyValueType.String;
            let value: PropertyValue = nominalValue as PropertyValue;

            // Handle typed values like IFCBOOLEAN(.T.), IFCREAL(1.5)
            if (Array.isArray(nominalValue) && nominalValue.length === 2) {
                const innerValue = nominalValue[1];
                const typeName = String(nominalValue[0]).toUpperCase();

                if (typeName.includes('BOOLEAN')) {
                    type = PropertyValueType.Boolean;
                    value = innerValue === '.T.' || innerValue === true;
                } else if (typeName.includes('LOGICAL')) {
                    type = PropertyValueType.Logical;
                    // Preserve .U. (unknown) as null; .T./.F. as boolean
                    if (innerValue === '.U.' || innerValue === '.X.') {
                        value = null;
                    } else {
                        value = innerValue === '.T.' || innerValue === true;
                    }
                } else if (typeof innerValue === 'number') {
                    if (Number.isInteger(innerValue)) {
                        type = PropertyValueType.Integer;
                    } else {
                        type = PropertyValueType.Real;
                    }
                    value = innerValue;
                } else {
                    type = PropertyValueType.String;
                    value = String(innerValue);
                }
            } else if (typeof nominalValue === 'number') {
                type = Number.isInteger(nominalValue) ? PropertyValueType.Integer : PropertyValueType.Real;
            } else if (typeof nominalValue === 'boolean') {
                type = PropertyValueType.Boolean;
            } else if (nominalValue !== null && nominalValue !== undefined) {
                value = String(nominalValue);
            }

            return { type, value };
        }
    }
}

/** Extract a numeric value from a possibly typed STEP value. */
export function extractNumericValue(attr: unknown): number | null {
    if (typeof attr === 'number') return attr;
    if (Array.isArray(attr) && attr.length === 2 && typeof attr[1] === 'number') return attr[1];
    return null;
}

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
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> {
    const result: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> = [];

    for (const psetId of psetIds) {
        const psetRef = store.entityIndex.byId.get(psetId);
        if (!psetRef) continue;

        // Only extract IFCPROPERTYSET entities (skip quantity sets etc.)
        if (psetRef.type.toUpperCase() !== 'IFCPROPERTYSET') continue;

        const psetEntity = extractor.extractEntity(psetRef);
        if (!psetEntity) continue;

        const psetAttrs = psetEntity.attributes || [];
        const psetGlobalId = typeof psetAttrs[0] === 'string' ? psetAttrs[0] : undefined;
        const psetName = typeof psetAttrs[2] === 'string' ? psetAttrs[2] : `PropertySet #${psetId}`;
        const hasProperties = psetAttrs[4];

        const properties: Array<{ name: string; type: number; value: PropertyValue }> = [];

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

                const parsed = parsePropertyValue(propEntity);
                properties.push({ name: propName, type: parsed.type, value: parsed.value });
            }
        }

        if (properties.length > 0 || psetName) {
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

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> = [];
    const seenPsetNames = new Set<string>();

    // Source 1: HasPropertySets attribute on the type entity (index 5 for IfcTypeObject subtypes)
    // Works for both IFC2X3 and IFC4
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            const psetIds = hasPropertySets.filter((id): id is number => typeof id === 'number');
            const psets = extractPsetsFromIds(store, extractor, psetIds);
            for (const pset of psets) {
                seenPsetNames.add(pset.name);
                allPsets.push(pset);
            }
        }
    }

    // Source 2: onDemandPropertyMap for the type entity (IFC4: via IFCRELDEFINESBYPROPERTIES)
    if (store.onDemandPropertyMap) {
        const typePsetIds = store.onDemandPropertyMap.get(typeId);
        if (typePsetIds && typePsetIds.length > 0) {
            const psets = extractPsetsFromIds(store, extractor, typePsetIds);
            for (const pset of psets) {
                if (!seenPsetNames.has(pset.name)) {
                    allPsets.push(pset);
                }
            }
        }
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
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> {
    const ref = store.entityIndex.byId.get(typeEntityId);
    if (!ref || !store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const typeEntity = extractor.extractEntity(ref);
    if (!typeEntity) return [];

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> = [];
    const seenPsetNames = new Set<string>();

    // Source 1: HasPropertySets attribute (index 5 for IfcTypeObject subtypes)
    const hasPropertySets = typeEntity.attributes?.[5];
    if (Array.isArray(hasPropertySets)) {
        const psetIds = hasPropertySets.filter((id): id is number => typeof id === 'number');
        const psets = extractPsetsFromIds(store, extractor, psetIds);
        for (const pset of psets) {
            seenPsetNames.add(pset.name);
            allPsets.push(pset);
        }
    }

    // Source 2: onDemandPropertyMap (IFC4: via IFCRELDEFINESBYPROPERTIES)
    if (store.onDemandPropertyMap) {
        const typePsetIds = store.onDemandPropertyMap.get(typeEntityId);
        if (typePsetIds && typePsetIds.length > 0) {
            const psets = extractPsetsFromIds(store, extractor, typePsetIds);
            for (const pset of psets) {
                if (!seenPsetNames.has(pset.name)) {
                    allPsets.push(pset);
                }
            }
        }
    }

    return allPsets;
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
        if (!ref) return { type: 'Unknown' };
        const name = store.entities?.getName(id);
        return { name: name || undefined, type: ref.type };
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

    // AssignsToGroup: groups this element belongs to
    const groupIds = store.relationships.getRelated(entityId, RelationshipType.AssignsToGroup, 'inverse');
    for (const id of groupIds) {
        const name = store.entities?.getName(id);
        result.groups.push({ id, name: name || undefined });
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

// ============================================================================
// On-Demand Georeferencing Extraction
// ============================================================================

/**
 * Extract georeferencing info from on-demand store (source buffer + entityIndex).
 * Bridges to the entity-based georef extractor by resolving entities lazily.
 */
export function extractGeoreferencingOnDemand(store: IfcDataStore): GeoreferenceInfo | null {
    if (!store.source?.length || !store.entityIndex) return null;

    const extractor = new EntityExtractor(store.source);
    const { byId, byType } = store.entityIndex;

    // Build a lightweight entity map for just the georef-related types
    const entityMap = new Map<number, { expressId: number; attributes: unknown[] }>();
    const typeMap = new Map<string, number[]>();

    for (const typeName of ['IFCMAPCONVERSION', 'IFCPROJECTEDCRS']) {
        const ids = byType.get(typeName);
        if (!ids?.length) continue;

        // Use mixed-case for the georef extractor's type lookup
        const displayName = typeName === 'IFCMAPCONVERSION' ? 'IfcMapConversion' : 'IfcProjectedCRS';
        typeMap.set(displayName, ids);

        for (const id of ids) {
            const ref = byId.get(id);
            if (!ref) continue;
            const entity = extractor.extractEntity(ref);
            if (entity) {
                entityMap.set(id, entity);

                // For IfcProjectedCRS, also resolve the MapUnit reference (attribute [6])
                // so the georef extractor can determine the actual unit scale
                if (typeName === 'IFCPROJECTEDCRS' && entity.attributes) {
                    const mapUnitAttr = entity.attributes[6];
                    const mapUnitRefId = typeof mapUnitAttr === 'number' ? mapUnitAttr : null;
                    if (mapUnitRefId && !entityMap.has(mapUnitRefId)) {
                        const unitRef = byId.get(mapUnitRefId);
                        if (unitRef) {
                            const unitEntity = extractor.extractEntity(unitRef);
                            if (unitEntity) entityMap.set(mapUnitRefId, unitEntity);
                        }
                    }
                }
            }
        }
    }

    if (entityMap.size === 0) return null;

    // Cast to IfcEntity (they share the same shape)
    return extractGeorefFromEntities(entityMap as Parameters<typeof extractGeorefFromEntities>[0], typeMap);
}
