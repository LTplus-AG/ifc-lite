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

export {
    resolveMaterialDefId,
    collectMaterialLeaves,
    buildMaterialUsageIndex,
    getMaterialDisplay,
} from './material-resolver.js';
export type { MaterialLeaf, MaterialUsage } from './material-resolver.js';

import {
    resolveMaterialDefId as resolveMaterialDefIdImpl,
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
export function parsePropertyValue(propEntity: IfcEntity): { type: number; value: PropertyValue; values?: string[]; dataType?: string } {
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
                // Surface the raw value list separately so IDS facet
                // checks can iterate "any matching value passes". The
                // joined display string remains the primary `value`
                // for visualisation/property-table consumers.
                return { type: 0, value: values.join(', ') || null, values };
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
            // Surface every defined bound as a candidate value — IDS
            // bounded-property checks pass when ANY of the bounds /
            // setpoint matches the constraint, per upstream ifctester.
            const candidates: string[] = [];
            if (lower != null) candidates.push(String(lower));
            if (upper != null && upper !== lower) candidates.push(String(upper));
            if (setPoint != null && setPoint !== lower && setPoint !== upper) {
                candidates.push(String(setPoint));
            }
            // Carry the IFC-declared measure tag so the IDS-side data
            // type comparison and unit conversion both work.
            const inferDataType = (attr: unknown): string | undefined => {
                if (Array.isArray(attr) && attr.length === 2) {
                    return String(attr[0]).toUpperCase();
                }
                return undefined;
            };
            const dataType =
                inferDataType(attrs[5]) ||
                inferDataType(attrs[2]) ||
                inferDataType(attrs[3]);
            return {
                type: displayValue != null ? 1 : 0,
                value: display || null,
                ...(candidates.length > 0 ? { values: candidates } : {}),
                ...(dataType ? { dataType } : {}),
            };
        }

        case 'IFCPROPERTYLISTVALUE': {
            // [Name, Description, ListValues (list), Unit]
            const listValues = attrs[2];
            if (Array.isArray(listValues)) {
                const values = listValues.map(v => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]);
                    return String(v);
                }).filter(v => v !== 'null' && v !== 'undefined');
                return { type: 0, value: values.join(', ') || null, values };
            }
            return { type: 0, value: null };
        }

        case 'IFCPROPERTYTABLEVALUE': {
            // [Name, Description, DefiningValues, DefinedValues, ...]
            const definingValues = attrs[2];
            const definedValues = attrs[3];
            const rowCount = Array.isArray(definingValues) ? definingValues.length : 0;
            if (rowCount > 0 && Array.isArray(definedValues) && Array.isArray(definingValues)) {
                // Surface both defining and defined values as candidate
                // matches — IDS table-value checks pass when ANY entry
                // matches the constraint (per upstream ifctester).
                const stringify = (v: unknown): string => {
                    if (Array.isArray(v) && v.length === 2) return String(v[1]);
                    return String(v);
                };
                const values = [
                    ...definingValues.map(stringify),
                    ...definedValues.map(stringify),
                ].filter(v => v !== 'null' && v !== 'undefined');
                // Tables mix types per column (label / length / …),
                // so we can't surface a single representative
                // dataType. Leaving it unset lets the IDS check fall
                // through to a pure value match against any of the
                // candidates — which is what upstream ifctester does
                // for table values.
                return {
                    type: 0,
                    value: `Table (${rowCount} rows)`,
                    values,
                };
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
            let dataType: string | undefined;

            // Handle typed values like IFCBOOLEAN(.T.), IFCREAL(1.5)
            if (Array.isArray(nominalValue) && nominalValue.length === 2) {
                const innerValue = nominalValue[1];
                const typeName = String(nominalValue[0]).toUpperCase();
                dataType = typeName;

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
                    // Preserve the IFC-declared numeric measure (IFCREAL,
                    // IFCINTEGER, IFCLENGTHMEASURE, IFCAREAMEASURE, …) —
                    // the source explicitly tagged the value, so don't
                    // re-infer from JS number-ness (which would
                    // misclassify e.g. `IFCREAL(0.0)` as integer).
                    if (typeName === 'IFCINTEGER' || typeName === 'IFCCOUNTMEASURE') {
                        type = PropertyValueType.Integer;
                    } else if (
                        typeName === 'IFCREAL' ||
                        typeName.endsWith('MEASURE') ||
                        typeName.endsWith('RATIO')
                    ) {
                        type = PropertyValueType.Real;
                    } else if (Number.isInteger(innerValue)) {
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
                // Normalize untagged STEP enumeration tokens. Conformant IFC wraps
                // booleans as IFCBOOLEAN(.T.) (handled above), but some authoring
                // tools emit the bare tokens directly in the NominalValue slot.
                if (nominalValue === '.T.') {
                    type = PropertyValueType.Boolean;
                    value = true;
                } else if (nominalValue === '.F.') {
                    type = PropertyValueType.Boolean;
                    value = false;
                } else if (nominalValue === '.U.' || nominalValue === '.X.') {
                    type = PropertyValueType.Logical;
                    value = null;
                } else {
                    value = String(nominalValue);
                }
            }

            return { type, value, ...(dataType ? { dataType } : {}) };
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
        const psetName = typeof psetAttrs[2] === 'string' ? psetAttrs[2] : `PropertySet #${psetId}`;
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

                const parsed = parsePropertyValue(propEntity);
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

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[] }> }> = [];
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
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> {
    const ref = store.entityIndex.byId.get(typeEntityId);
    if (!ref || !store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const typeEntity = extractor.extractEntity(ref);
    if (!typeEntity) return [];

    const allPsets: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> = [];
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

/**
 * Extract georeferencing info from on-demand store (source buffer + entityIndex).
 * Bridges to the entity-based georef extractor by resolving entities lazily.
 *
 * Memoized per store. On models without an IfcMapConversion (e.g. IFC2x3 files
 * that carry CRS in ePSet_MapConversion / ePSet_ProjectedCRS) the underlying
 * scan decodes EVERY IfcPropertySet from the source buffer to match by name —
 * tens of thousands of decodes on property-heavy models. The viewer calls this
 * on the load/render path (ViewportContainer's Cesium-availability check), which
 * re-runs on every streamed geometry batch, so without caching the cost is
 * O(batches x propertySets) and can turn a multi-second load into minutes.
 * Caching collapses it to a single scan per store. Safe because the result is a
 * pure function of the immutable source + entityIndex; georef *edits* are layered
 * on top later in getEffectiveGeoreference(), not here.
 */
/**
 * Memoize an O(entities) on-demand extraction per store. On-demand extractors
 * derive purely from the immutable source + entityIndex, but the viewer calls
 * them on render/stream hot paths where they can re-run once per geometry batch
 * (regression #1404). Caching by store collapses that to one scan per model.
 * Use this for any new `extract*OnDemand` so the whole family stays O(1)-per-call
 * regardless of how often the render layer invokes it.
 */
const onDemandCaches = new WeakMap<IfcDataStore, Map<string, unknown>>();
function oncePerStore<T>(store: IfcDataStore, key: string, compute: () => T): T {
    let byKey = onDemandCaches.get(store);
    if (!byKey) { byKey = new Map(); onDemandCaches.set(store, byKey); }
    if (byKey.has(key)) return byKey.get(key) as T;
    const value = compute();
    byKey.set(key, value);
    return value;
}

export function extractGeoreferencingOnDemand(store: IfcDataStore): GeoreferenceInfo | null {
    // Don't cache a not-yet-loaded store — it may gain source/entityIndex later.
    if (!store.source?.length || !store.entityIndex) return null;
    return oncePerStore(store, 'georef', () => computeGeoreferencingOnDemand(store));
}

function computeGeoreferencingOnDemand(store: IfcDataStore): GeoreferenceInfo | null {
    if (!store.source?.length || !store.entityIndex) return null;

    const extractor = new EntityExtractor(store.source);
    const { byId, byType } = store.entityIndex;

    // Build a lightweight entity map for just the georef-related types
    const entityMap = new Map<number, { expressId: number; attributes: unknown[] }>();
    const typeMap = new Map<string, number[]>();

    for (const typeName of ['IFCMAPCONVERSION', 'IFCPROJECTEDCRS', 'IFCSITE']) {
        const ids = byType.get(typeName);
        if (!ids?.length) continue;

        // Use mixed-case for the georef extractor's type lookup
        const displayName = typeName === 'IFCMAPCONVERSION'
            ? 'IfcMapConversion'
            : typeName === 'IFCPROJECTEDCRS'
                ? 'IfcProjectedCRS'
                : 'IfcSite';
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

    // IFC2x3 fallback: models without IfcMapConversion store georeferencing in
    // ePSet_MapConversion / ePSet_ProjectedCRS property sets. Those aren't
    // loaded above, so the ePSet path in extractGeorefFromEntities had nothing
    // to read and the model fell back to the legacy IfcSite EPSG:4326 (wrong
    // CRS). Only scan property sets when no IfcMapConversion exists, and only
    // pull in the georef ePSets + their values — not every pset in the model.
    if (!typeMap.has('IfcMapConversion')) {
        const psetIds = byType.get('IFCPROPERTYSET');
        if (psetIds?.length) {
            const georefPsetIds: number[] = [];
            const childIds = new Set<number>();
            for (const id of psetIds) {
                const ref = byId.get(id);
                if (!ref) continue;
                const entity = extractor.extractEntity(ref);
                if (!entity?.attributes) continue;
                // IfcPropertySet: Name (2), HasProperties (4)
                const name = typeof entity.attributes[2] === 'string'
                    ? (entity.attributes[2] as string).toLowerCase()
                    : '';
                if (name !== 'epset_mapconversion' && name !== 'epset_projectedcrs') continue;
                entityMap.set(id, entity);
                georefPsetIds.push(id);
                const props = entity.attributes[4];
                if (Array.isArray(props)) {
                    for (const propRef of props) {
                        const propId = typeof propRef === 'number' ? propRef : null;
                        if (propId === null || childIds.has(propId)) continue;
                        // Property atoms may be deferred on huge files (not in
                        // the primary byId index) — fall back like refFromStore.
                        const childRef = byId.get(propId) ?? store.deferredEntityIndex?.get(propId);
                        if (!childRef) continue;
                        const child = extractor.extractEntity(childRef);
                        if (child) {
                            entityMap.set(propId, child);
                            childIds.add(propId);
                        }
                    }
                }
            }
            if (georefPsetIds.length) {
                typeMap.set('IfcPropertySet', georefPsetIds);
            }
        }
    }

    if (entityMap.size === 0) return null;

    // Cast to IfcEntity (they share the same shape)
    return extractGeorefFromEntities(entityMap as Parameters<typeof extractGeorefFromEntities>[0], typeMap);
}

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
                const pv = parsePropertyValue(propEntity);
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
    const defId = resolveMaterialDefIdImpl(store, entityId);
    if (defId === undefined) return [];
    const leafIds = collectMaterialLeavesImpl(store, defId).map((l) => l.id);
    return buildMaterialPsetGroups(store, [defId, ...leafIds]);
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
