/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Columnar parser - builds columnar data structures
 *
 * OPTIMIZED: Single-pass extraction for maximum performance
 * Instead of multiple passes through entities, we extract everything in ONE loop.
 */

import type { EntityRef } from './types.js';
import { SpatialHierarchyBuilder } from './spatial-hierarchy-builder.js';
import { EntityExtractor } from './entity-extractor.js';
import { extractLengthUnitScale } from './unit-extractor.js';
import { getAttributeNames, getInheritanceChain } from './ifc-schema.js';
import { parsePropertyValue } from './on-demand-extractors.js';
import { buildCompactEntityIndexAsync } from './compact-entity-index.js';
import {
    StringTable,
    EntityTableBuilder,
    PropertyTableBuilder,
    QuantityTableBuilder,
    RelationshipGraphBuilder,
    RelationshipType,
    QuantityType,
} from '@ifc-lite/data';
import type { SpatialHierarchy, QuantityTable, PropertyValue } from '@ifc-lite/data';
import { batchExtractGlobalIdAndName } from './columnar-parser-attributes.js';
import {
    GEOMETRY_TYPES,
    REL_TYPE_MAP,
    QUANTITY_TYPE_MAP,
    SPATIAL_TYPES,
    HIERARCHY_REL_TYPES,
    PROPERTY_REL_TYPES,
    ASSOCIATION_REL_TYPES,
    SKIP_DISPLAY_ATTRS,
    PROPERTY_ENTITY_TYPES,
    PROPERTY_CONTAINER_TYPES,
    isIfcTypeLikeEntity,
} from './columnar-parser-indexes.js';
import { extractRelFast, extractPropertyRelFast } from './columnar-parser-relationships.js';

import type { SpatialIndex, EntityByIdIndex } from './columnar-parser-indexes.js';

// Re-export interfaces/types from extracted modules for public API compatibility
export type { SpatialIndex, EntityByIdIndex } from './columnar-parser-indexes.js';

export interface IfcDataStore {
    fileSize: number;
    schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
    entityCount: number;
    parseTime: number;

    source: Uint8Array;
    entityIndex: { byId: EntityByIdIndex; byType: Map<string, number[]> };
    deferredEntityIndex?: EntityByIdIndex;

    strings: StringTable;
    entities: ReturnType<EntityTableBuilder['build']>;
    properties: ReturnType<PropertyTableBuilder['build']>;
    quantities: QuantityTable;
    relationships: ReturnType<RelationshipGraphBuilder['build']>;

    spatialHierarchy?: SpatialHierarchy;
    spatialIndex?: SpatialIndex;

    /**
     * On-demand property lookup: entityId -> array of property set expressIds
     * Used for fast single-entity property access without pre-building property tables.
     * Use extractPropertiesOnDemand() with this map for instant property retrieval.
     */
    onDemandPropertyMap?: Map<number, number[]>;

    /**
     * On-demand quantity lookup: entityId -> array of quantity set expressIds
     * Used for fast single-entity quantity access without pre-building quantity tables.
     * Use extractQuantitiesOnDemand() with this map for instant quantity retrieval.
     */
    onDemandQuantityMap?: Map<number, number[]>;

    /**
     * On-demand classification lookup: entityId -> array of IfcClassificationReference expressIds
     * Built from IfcRelAssociatesClassification relationships during parsing.
     */
    onDemandClassificationMap?: Map<number, number[]>;

    /**
     * On-demand material lookup: entityId -> relatingMaterial expressId
     * Built from IfcRelAssociatesMaterial relationships during parsing.
     * Value is the expressId of IfcMaterial, IfcMaterialLayerSet, IfcMaterialProfileSet, or IfcMaterialConstituentSet.
     */
    onDemandMaterialMap?: Map<number, number>;

    /**
     * On-demand document lookup: entityId -> array of IfcDocumentReference/IfcDocumentInformation expressIds
     * Built from IfcRelAssociatesDocument relationships during parsing.
     */
    onDemandDocumentMap?: Map<number, number[]>;
}


function detectSchemaVersion(buffer: Uint8Array): IfcDataStore['schemaVersion'] {
    const headerEnd = Math.min(buffer.length, 2000);
    const headerText = new TextDecoder().decode(buffer.subarray(0, headerEnd)).toUpperCase();

    if (headerText.includes('IFC5')) return 'IFC5';
    if (headerText.includes('IFC4X3')) return 'IFC4X3';
    if (headerText.includes('IFC4')) return 'IFC4';
    if (headerText.includes('IFC2X3')) return 'IFC2X3';

    return 'IFC4'; // Default fallback
}

function yieldToEventLoop(): Promise<void> {
    const maybeScheduler = (globalThis as typeof globalThis & {
        scheduler?: { yield?: () => Promise<void> };
    }).scheduler;
    if (typeof maybeScheduler?.yield === 'function') {
        return maybeScheduler.yield();
    }
    return new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
    });
}

export class ColumnarParser {
    /**
     * Parse IFC file into columnar data store
     *
     * Uses fast semicolon-based scanning with on-demand property extraction.
     * Properties are parsed lazily when accessed, not upfront.
     * This provides instant UI responsiveness even for very large files.
     */
    async parseLite(
        buffer: ArrayBuffer,
        entityRefs: EntityRef[],
        options: {
            onProgress?: (progress: { phase: string; percent: number }) => void;
            onDiagnostic?: (message: string) => void;
            yieldIntervalMs?: number;
            deferPropertyAtomIndex?: boolean;
            onSpatialReady?: (partialStore: IfcDataStore) => void;
        } = {}
    ): Promise<IfcDataStore> {
        const startTime = performance.now();
        const uint8Buffer = new Uint8Array(buffer);
        const totalEntities = entityRefs.length;

        // Phase timing for performance telemetry
        let phaseStart = startTime;
        const emitDiagnostic = (message: string) => {
            options.onDiagnostic?.(message);
        };
        const logPhase = (name: string) => {
            const now = performance.now();
            const elapsed = Math.round(now - phaseStart);
            console.log(`[parseLite] ${name}: ${elapsed}ms`);
            emitDiagnostic(`${name}: ${elapsed}ms`);
            phaseStart = now;
        };

        options.onProgress?.({ phase: 'building', percent: 0 });

        // Detect schema version from FILE_SCHEMA header
        const schemaVersion = detectSchemaVersion(uint8Buffer);

        // Initialize builders (entity table capacity set after categorization below)
        const strings = new StringTable();
        const propertyTableBuilder = new PropertyTableBuilder(strings);
        const quantityTableBuilder = new QuantityTableBuilder(strings);
        const relationshipGraphBuilder = new RelationshipGraphBuilder();

        logPhase('init builders');

        // Single pass: build byType index AND categorize entities simultaneously.
        // Uses a type-name cache to avoid calling .toUpperCase() on 4.4M refs
        // (only ~776 unique type names in IFC4).
        const byType = new Map<string, number[]>();
        const deferPropertyAtomIndex = options.deferPropertyAtomIndex === true;
        const typeUpperCache = new Map<string, string>();
        const getTypeUpper = (type: string) => {
            let upper = typeUpperCache.get(type);
            if (upper === undefined) {
                upper = type.toUpperCase();
                typeUpperCache.set(type, upper);
            }
            return upper;
        };

        const RELEVANT_ENTITY_PREFIXES = new Set([
            'IFCWALL', 'IFCSLAB', 'IFCBEAM', 'IFCCOLUMN', 'IFCPLATE', 'IFCDOOR', 'IFCWINDOW',
            'IFCROOF', 'IFCSTAIR', 'IFCRAILING', 'IFCRAMP', 'IFCFOOTING', 'IFCPILE',
            'IFCMEMBER', 'IFCCURTAINWALL', 'IFCBUILDINGELEMENTPROXY', 'IFCFURNISHINGELEMENT',
            'IFCFLOWSEGMENT', 'IFCFLOWTERMINAL', 'IFCFLOWCONTROLLER', 'IFCFLOWFITTING',
            'IFCSPACE', 'IFCOPENINGELEMENT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
            'IFCPROJECT', 'IFCCOVERING', 'IFCANNOTATION', 'IFCGRID',
            // Infrastructure entities needed by on-demand extraction and StepExporter.
            // Without these, findPreferredGeometricRepresentationContextId() and
            // findLengthUnitReference() fail because the entities are not in byId.
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

        // Category constants for the lookup cache
        const CAT_SKIP = 0, CAT_SPATIAL = 1, CAT_GEOMETRY = 2, CAT_HIERARCHY_REL = 3,
              CAT_PROPERTY_REL = 4, CAT_PROPERTY_ENTITY = 5, CAT_ASSOCIATION_REL = 6,
              CAT_TYPE_OBJECT = 7, CAT_RELEVANT = 8;


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
            else if (RELEVANT_ENTITY_PREFIXES.has(upper) || upper.startsWith('IFCREL')) cat = CAT_RELEVANT;
            else cat = CAT_SKIP;
            typeCategoryCache.set(type, cat);
            return cat;
        }

        // Time-based yielding: yield to the main thread every ~80ms so geometry
        // streaming callbacks can fire. This limits main-thread blocking to short
        // bursts that don't starve geometry, while adding minimal overhead (~15 yields
        // × ~1ms each ≈ 15ms total over the full parse).
        const YIELD_INTERVAL_MS = Math.max(16, options.yieldIntervalMs ?? 80);
        let lastYieldTime = performance.now();
        const yieldIfNeeded = async () => {
            const now = performance.now();
            if (now - lastYieldTime >= YIELD_INTERVAL_MS) {
                await yieldToEventLoop();
                lastYieldTime = performance.now();
            }
        };

        emitDiagnostic(`parseLite start: totalEntities=${totalEntities} yieldInterval=${YIELD_INTERVAL_MS}ms`);

        const spatialRefs: EntityRef[] = [];
        const geometryRefs: EntityRef[] = [];
        const relationshipRefs: EntityRef[] = [];
        const propertyRelRefs: EntityRef[] = [];
        const propertyContainerRefs: EntityRef[] = [];
        const propertyAtomRefs: EntityRef[] = [];
        const associationRelRefs: EntityRef[] = [];
        const typeObjectRefs: EntityRef[] = [];
        const otherRelevantRefs: EntityRef[] = [];

        for (let i = 0; i < entityRefs.length; i++) {
            if ((i & 0x3FF) === 0) await yieldIfNeeded();
            const ref = entityRefs[i];
            // Categorize (cached — .toUpperCase() called once per unique type)
            const cat = getCategory(ref.type);
            const typeUpper = cat === CAT_PROPERTY_ENTITY ? getTypeUpper(ref.type) : '';
            // ALL entities must be indexed in byType for on-demand extraction
            // (e.g. IfcGeometricRepresentationContext, IfcSiUnit, IfcMaterialLayer).
            // Only property atoms are optionally deferred for huge-file lazy loading.
            const includeInPrimaryIndex =
                !deferPropertyAtomIndex || cat !== CAT_PROPERTY_ENTITY || PROPERTY_CONTAINER_TYPES.has(typeUpper);
            if (includeInPrimaryIndex) {
                // STEP convention is uppercase entity type names and every
                // downstream consumer (schedule-extractor, property readers,
                // test helpers) keys on uppercase. The tokenizer preserves
                // original case though, so if a STEP writer ever emits
                // mixed-case or lowercase types the index would miss on
                // canonical lookups. Normalise once here — `getTypeUpper`
                // is already cached by type name so the cost is ~0.
                const typeKey = getTypeUpper(ref.type);
                let typeList = byType.get(typeKey);
                if (!typeList) { typeList = []; byType.set(typeKey, typeList); }
                typeList.push(ref.expressId);
            }
            if (cat === CAT_SPATIAL) spatialRefs.push(ref);
            else if (cat === CAT_GEOMETRY) geometryRefs.push(ref);
            else if (cat === CAT_HIERARCHY_REL) relationshipRefs.push(ref);
            else if (cat === CAT_PROPERTY_REL) propertyRelRefs.push(ref);
            else if (cat === CAT_PROPERTY_ENTITY) {
                if (PROPERTY_CONTAINER_TYPES.has(typeUpper)) propertyContainerRefs.push(ref);
                else propertyAtomRefs.push(ref);
            }
            else if (cat === CAT_ASSOCIATION_REL) associationRelRefs.push(ref);
            else if (cat === CAT_TYPE_OBJECT) typeObjectRefs.push(ref);
            else if (cat === CAT_RELEVANT) otherRelevantRefs.push(ref);
        }

        logPhase(`categorize ${totalEntities} → spatial:${spatialRefs.length} geom:${geometryRefs.length} rel:${relationshipRefs.length} propRel:${propertyRelRefs.length} propContainers:${propertyContainerRefs.length} propAtoms:${propertyAtomRefs.length} assocRel:${associationRelRefs.length} type:${typeObjectRefs.length} other:${otherRelevantRefs.length}`);

        // Pre-scan association rels to discover relatingRef target IDs (e.g.
        // IfcClassificationReference, IfcMaterial, IfcDocumentReference).  These
        // entities are typically categorised as CAT_SKIP and would otherwise be
        // missing from the compact index, making on-demand extraction fail.
        const associationTargetIds = new Set<number>();
        for (const ref of associationRelRefs) {
            const result = extractPropertyRelFast(uint8Buffer, ref.byteOffset, ref.byteLength);
            if (result) associationTargetIds.add(result.relatingDef);
        }

        // Collect EntityRefs for association targets that aren't already categorised.
        // Single O(n) pass over entityRefs filtered to the (small) target ID set.
        const alreadyIndexedIds = new Set<number>();
        for (const arr of [spatialRefs, geometryRefs, relationshipRefs, propertyRelRefs,
            propertyContainerRefs, associationRelRefs, typeObjectRefs, otherRelevantRefs,
            ...(deferPropertyAtomIndex ? [] : [propertyAtomRefs])]) {
            for (const r of arr) alreadyIndexedIds.add(r.expressId);
        }
        const extraAssocRefs: EntityRef[] = [];
        for (const ref of entityRefs) {
            if (associationTargetIds.has(ref.expressId) && !alreadyIndexedIds.has(ref.expressId)) {
                extraAssocRefs.push(ref);
            }
        }
        logPhase(`association target pre-scan: ${associationTargetIds.size} targets, ${extraAssocRefs.length} extra refs`);

        // ALL entity refs must be indexed in byId so that on-demand extraction
        // can look up any entity by expressId (e.g. IfcUnitAssignment,
        // IfcGeometricRepresentationContext, IfcSiUnit, IfcLocalPlacement, etc.).
        // Only property atoms are optionally deferred for huge-file lazy loading.
        const indexedRefs = deferPropertyAtomIndex
            ? entityRefs.filter(ref => {
                const cat = getCategory(ref.type);
                return cat !== CAT_PROPERTY_ENTITY || PROPERTY_CONTAINER_TYPES.has(getTypeUpper(ref.type));
              })
            : entityRefs;
        emitDiagnostic(
            `index input: indexedRefs=${indexedRefs.length} deferredPropertyAtoms=${deferPropertyAtomIndex ? propertyAtomRefs.length : 0} extraAssocTargets=${extraAssocRefs.length}`
        );

        // Build compact entity index from only the refs that survive lite parsing.
        // This avoids spending huge-file startup time indexing millions of skipped
        // representation/helper entities that the viewer never queries.
        const compactByIdIndex = await buildCompactEntityIndexAsync(indexedRefs);
        logPhase('compact entity index');

        // Create entity table builder with EXACT capacity (not totalEntities which
        // includes millions of geometry-representation entities we don't store).
        // For a 14M entity file, this reduces allocation from ~546MB to ~20MB.
        const relevantCount = spatialRefs.length + geometryRefs.length + typeObjectRefs.length
            + relationshipRefs.length + otherRelevantRefs.length;
        const entityTableBuilder = new EntityTableBuilder(relevantCount, strings);

        const entityIndex = {
            byId: compactByIdIndex as EntityByIdIndex,
            byType,
        };

        // === TARGETED PARSING using batch byte-level extraction ===
        // Uses 2 TextDecoder.decode() calls total for ALL entity GlobalIds/Names
        // (instead of per-entity calls), and pure byte scanning for relationships.
        options.onProgress?.({ phase: 'parsing entities', percent: 10 });

        const extractor = new EntityExtractor(uint8Buffer);

        // Spatial entities: small count, use extractEntity for full accuracy
        const parsedEntityData = new Map<number, { globalId: string; name: string }>();
        for (const ref of spatialRefs) {
            const entity = extractor.extractEntity(ref);
            if (entity) {
                const attrs = entity.attributes || [];
                parsedEntityData.set(ref.expressId, {
                    globalId: typeof attrs[0] === 'string' ? attrs[0] : '',
                    name: typeof attrs[2] === 'string' ? attrs[2] : '',
                });
            }
        }
        logPhase('spatial entities');

        await yieldIfNeeded();

        // Geometry + type object entities: batch extract GlobalId+Name with 2 TextDecoder calls
        options.onProgress?.({ phase: 'parsing geometry names', percent: 12 });
        const geomData = await batchExtractGlobalIdAndName(uint8Buffer, geometryRefs, yieldIfNeeded);
        for (const [id, data] of geomData) parsedEntityData.set(id, data);

        await yieldIfNeeded();

        const typeData = await batchExtractGlobalIdAndName(uint8Buffer, typeObjectRefs, yieldIfNeeded);
        for (const [id, data] of typeData) parsedEntityData.set(id, data);
        logPhase('batch geom GlobalId+Name');

        await yieldIfNeeded();

        // Relationships: byte-level scanning (numbers only, no TextDecoder)
        options.onProgress?.({ phase: 'parsing relationships', percent: 20 });

        for (let i = 0; i < relationshipRefs.length; i++) {
            if ((i & 0x3FF) === 0) await yieldIfNeeded();
            const ref = relationshipRefs[i];
            const typeUpper = getTypeUpper(ref.type);
            const rel = extractRelFast(uint8Buffer, ref.byteOffset, ref.byteLength, typeUpper);
            if (rel) {
                const relType = REL_TYPE_MAP[typeUpper];
                if (relType) {
                    for (const targetId of rel.relatedObjects) {
                        relationshipGraphBuilder.addEdge(rel.relatingObject, targetId, relType, ref.expressId);
                    }
                }
            }
        }

        logPhase('byte-level relationships');

        // === BUILD ENTITY TABLE from categorized arrays ===
        // Instead of iterating ALL 4.4M entityRefs, iterate only categorized arrays
        // (~100K-200K total). This eliminates a 200-300ms loop over 4.4M items.
        options.onProgress?.({ phase: 'building entities', percent: 30 });

        // Helper to add entities with pre-parsed data
        const addEntityBatch = (refs: EntityRef[], hasGeometry: boolean, isType: boolean) => {
            for (const ref of refs) {
                const entityData = parsedEntityData.get(ref.expressId);
                entityTableBuilder.add(
                    ref.expressId,
                    ref.type,
                    entityData?.globalId || '',
                    entityData?.name || '',
                    '', // description
                    '', // objectType
                    hasGeometry,
                    isType
                );
            }
        };

        addEntityBatch(spatialRefs, false, false);
        addEntityBatch(geometryRefs, true, false);
        addEntityBatch(typeObjectRefs, false, true);
        addEntityBatch(relationshipRefs, false, false);
        addEntityBatch(otherRelevantRefs, false, false);
        logPhase('add entity batches');

        const entityTable = entityTableBuilder.build();
        logPhase('entity table build()');

        // Empty property/quantity tables - use on-demand extraction instead
        const propertyTable = propertyTableBuilder.build();
        const quantityTable = quantityTableBuilder.build();

        // Build intermediate relationship graph (spatial/hierarchy edges only).
        // Property/association edges are added later; final graph is rebuilt at the end.
        const hierarchyRelGraph = relationshipGraphBuilder.build();
        logPhase('hierarchy rel graph build()');

        await yieldIfNeeded();

        // === EXTRACT LENGTH UNIT SCALE ===
        options.onProgress?.({ phase: 'extracting units', percent: 85 });
        const lengthUnitScale = extractLengthUnitScale(uint8Buffer, entityIndex);

        // === BUILD SPATIAL HIERARCHY ===
        options.onProgress?.({ phase: 'building hierarchy', percent: 90 });

        let spatialHierarchy: SpatialHierarchy | undefined;
        try {
            const hierarchyBuilder = new SpatialHierarchyBuilder();
            spatialHierarchy = hierarchyBuilder.build(
                entityTable,
                hierarchyRelGraph,
                strings,
                uint8Buffer,
                entityIndex,
                lengthUnitScale
            );
            logPhase('spatial hierarchy');
        } catch (error) {
            console.warn('[ColumnarParser] Failed to build spatial hierarchy:', error);
        }

        // === EMIT SPATIAL HIERARCHY EARLY ===
        // The hierarchy panel can render immediately while property/association
        // parsing continues. This lets the panel appear at the same time as
        // geometry streaming completes.
        const earlyStore: IfcDataStore = {
            fileSize: buffer.byteLength,
            schemaVersion,
            entityCount: totalEntities,
            parseTime: performance.now() - startTime,
            source: uint8Buffer,
            entityIndex,
            strings,
            entities: entityTable,
            properties: propertyTable,
            quantities: quantityTable,
            relationships: hierarchyRelGraph,
            spatialHierarchy,
        };
        options.onSpatialReady?.(earlyStore);

        await yieldIfNeeded(); // Let geometry process after hierarchy emission

        // === DEFERRED: Parse property and association relationships ===
        // These are NOT needed for the spatial hierarchy panel.
        options.onProgress?.({ phase: 'parsing property refs', percent: 92 });

        const onDemandPropertyMap = new Map<number, number[]>();
        const onDemandQuantityMap = new Map<number, number[]>();

        // Pre-build Sets of property set / quantity set IDs from already-categorized refs.
        // This replaces 252K binary searches on the 14M compact entity index with O(1) Set lookups.
        const propertySetIds = new Set<number>();
        const quantitySetIds = new Set<number>();
        for (const ref of propertyContainerRefs) {
            const tu = getTypeUpper(ref.type);
            if (tu === 'IFCPROPERTYSET') propertySetIds.add(ref.expressId);
            else if (tu === 'IFCELEMENTQUANTITY') quantitySetIds.add(ref.expressId);
        }

        // Property rels: byte-level scanning + addEdge (now fast with SoA builder).
        let totalPropRelObjects = 0;
        for (let pi = 0; pi < propertyRelRefs.length; pi++) {
            if ((pi & 0x3FF) === 0) await yieldIfNeeded();
            const ref = propertyRelRefs[pi];
            const result = extractPropertyRelFast(uint8Buffer, ref.byteOffset, ref.byteLength);
            if (result) {
                const { relatedObjects, relatingDef } = result;
                totalPropRelObjects += relatedObjects.length;

                for (const objId of relatedObjects) {
                    relationshipGraphBuilder.addEdge(relatingDef, objId, RelationshipType.DefinesByProperties, ref.expressId);
                }

                // Build on-demand property/quantity maps using pre-built Sets (O(1) vs binary search)
                const isPropSet = propertySetIds.has(relatingDef);
                const isQtySet = !isPropSet && quantitySetIds.has(relatingDef);

                if (isPropSet || isQtySet) {
                    const targetMap = isPropSet ? onDemandPropertyMap : onDemandQuantityMap;
                    for (const objId of relatedObjects) {
                        let list = targetMap.get(objId);
                        if (!list) { list = []; targetMap.set(objId, list); }
                        list.push(relatingDef);
                    }
                }
            }
        }
        await yieldIfNeeded();

        // Association rels: byte-level scanning, no addEdge (same reasoning as property rels)
        options.onProgress?.({ phase: 'parsing associations', percent: 95 });

        const onDemandClassificationMap = new Map<number, number[]>();
        const onDemandMaterialMap = new Map<number, number>();
        const onDemandDocumentMap = new Map<number, number[]>();

        for (let i = 0; i < associationRelRefs.length; i++) {
            if ((i & 0x3FF) === 0) await yieldIfNeeded();
            const ref = associationRelRefs[i];
            const result = extractPropertyRelFast(uint8Buffer, ref.byteOffset, ref.byteLength);
            if (result) {
                const { relatedObjects, relatingDef: relatingRef } = result;
                const typeUpper = getTypeUpper(ref.type);

                if (typeUpper === 'IFCRELASSOCIATESCLASSIFICATION') {
                    for (const objId of relatedObjects) {
                        let list = onDemandClassificationMap.get(objId);
                        if (!list) { list = []; onDemandClassificationMap.set(objId, list); }
                        list.push(relatingRef);
                        relationshipGraphBuilder.addEdge(relatingRef, objId, RelationshipType.AssociatesClassification, ref.expressId);
                    }
                } else if (typeUpper === 'IFCRELASSOCIATESMATERIAL') {
                    for (const objId of relatedObjects) {
                        onDemandMaterialMap.set(objId, relatingRef);
                        relationshipGraphBuilder.addEdge(relatingRef, objId, RelationshipType.AssociatesMaterial, ref.expressId);
                    }
                } else if (typeUpper === 'IFCRELASSOCIATESDOCUMENT') {
                    for (const objId of relatedObjects) {
                        let list = onDemandDocumentMap.get(objId);
                        if (!list) { list = []; onDemandDocumentMap.set(objId, list); }
                        list.push(relatingRef);
                        relationshipGraphBuilder.addEdge(relatingRef, objId, RelationshipType.AssociatesDocument, ref.expressId);
                    }
                }
            }
        }

        logPhase('property+association rels');

        // Rebuild relationship graph with ALL edges (hierarchy + property + association)
        const fullRelationshipGraph = relationshipGraphBuilder.build();
        logPhase('relationship graph build()');

        let deferredEntityIndex: EntityByIdIndex | undefined;
        if (deferPropertyAtomIndex && propertyAtomRefs.length > 0) {
            options.onProgress?.({ phase: 'indexing property atoms', percent: 98 });
            deferredEntityIndex = await buildCompactEntityIndexAsync(
                propertyAtomRefs,
                undefined,
                1024,
                2,
            );
            logPhase('deferred property atom index');
        }

        const parseTime = performance.now() - startTime;
        options.onProgress?.({ phase: 'complete', percent: 100 });

        return {
            ...earlyStore,
            parseTime,
            relationships: fullRelationshipGraph,
            deferredEntityIndex,
            onDemandPropertyMap,
            onDemandQuantityMap,
            onDemandClassificationMap,
            onDemandMaterialMap,
            onDemandDocumentMap,
        };
    }

    /**
     * Extract properties for a single entity ON-DEMAND
     * Parses only what's needed from the source buffer - instant results.
     */
    extractPropertiesOnDemand(
        store: IfcDataStore,
        entityId: number
    ): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> {
        // Use on-demand extraction if map is available (preferred for single-entity access)
        if (!store.onDemandPropertyMap || !store.source?.length) {
            // Fallback to pre-computed property table (e.g., server-parsed data)
            return store.properties.getForEntity(entityId);
        }

        const psetIds = store.onDemandPropertyMap.get(entityId);
        if (!psetIds || psetIds.length === 0) {
            return [];
        }

        const extractor = new EntityExtractor(store.source);
        const result: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> = [];

        for (const psetId of psetIds) {
            const psetRef = getEntityRefFromStore(store, psetId);
            if (!psetRef) continue;

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

                    const propEntityRef = getEntityRefFromStore(store, propRef);
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

    /**
     * Extract quantities for a single entity ON-DEMAND
     * Parses only what's needed from the source buffer - instant results.
     */
    extractQuantitiesOnDemand(
        store: IfcDataStore,
        entityId: number
    ): Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> {
        // Use on-demand extraction if map is available (preferred for single-entity access)
        if (!store.onDemandQuantityMap || !store.source?.length) {
            // Fallback to pre-computed quantity table (e.g., server-parsed data)
            return store.quantities.getForEntity(entityId);
        }

        const qsetIds = store.onDemandQuantityMap.get(entityId);
        if (!qsetIds || qsetIds.length === 0) {
            return [];
        }

        const extractor = new EntityExtractor(store.source);
        const result: Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> = [];

        for (const qsetId of qsetIds) {
            const qsetRef = getEntityRefFromStore(store, qsetId);
            if (!qsetRef) continue;

            const qsetEntity = extractor.extractEntity(qsetRef);
            if (!qsetEntity) continue;

            const qsetAttrs = qsetEntity.attributes || [];
            const qsetName = typeof qsetAttrs[2] === 'string' ? qsetAttrs[2] : `QuantitySet #${qsetId}`;
            const hasQuantities = qsetAttrs[5];

            const quantities: Array<{ name: string; type: number; value: number }> = [];

            if (Array.isArray(hasQuantities)) {
                for (const qtyRef of hasQuantities) {
                    if (typeof qtyRef !== 'number') continue;

                    const qtyEntityRef = getEntityRefFromStore(store, qtyRef);
                    if (!qtyEntityRef) continue;

                    const qtyEntity = extractor.extractEntity(qtyEntityRef);
                    if (!qtyEntity) continue;

                    const qtyAttrs = qtyEntity.attributes || [];
                    const qtyName = typeof qtyAttrs[0] === 'string' ? qtyAttrs[0] : '';
                    if (!qtyName) continue;

                    // Get quantity type from entity type
                    const qtyTypeUpper = qtyEntity.type.toUpperCase();
                    const qtyType = QUANTITY_TYPE_MAP[qtyTypeUpper] ?? QuantityType.Count;

                    // Value is at index 3 for most quantity types
                    const value = typeof qtyAttrs[3] === 'number' ? qtyAttrs[3] : 0;

                    quantities.push({ name: qtyName, type: qtyType, value });
                }
            }

            if (quantities.length > 0 || qsetName) {
                result.push({ name: qsetName, quantities });
            }
        }

        return result;
    }
}

/**
 * Standalone on-demand property extractor
 * Can be used outside ColumnarParser class
 */
export function extractPropertiesOnDemand(
    store: IfcDataStore,
    entityId: number
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue }> }> {
    const parser = new ColumnarParser();
    return parser.extractPropertiesOnDemand(store, entityId);
}

/**
 * Standalone on-demand quantity extractor
 * Can be used outside ColumnarParser class
 */
export function extractQuantitiesOnDemand(
    store: IfcDataStore,
    entityId: number
): Array<{ name: string; quantities: Array<{ name: string; type: number; value: number }> }> {
    const parser = new ColumnarParser();
    return parser.extractQuantitiesOnDemand(store, entityId);
}

function getEntityRefFromStore(store: IfcDataStore, expressId: number): EntityRef | undefined {
    return store.entityIndex.byId.get(expressId) ?? store.deferredEntityIndex?.get(expressId);
}

/**
 * Extract entity attributes on-demand from source buffer
 * Returns globalId, name, description, objectType, tag for any IfcRoot-derived entity.
 * This is used for entities that weren't fully parsed during initial load.
 */
export function extractEntityAttributesOnDemand(
    store: IfcDataStore,
    entityId: number
): { globalId: string; name: string; description: string; objectType: string; tag: string } {
    const ref = store.entityIndex.byId.get(entityId);
    if (!ref) {
        return { globalId: '', name: '', description: '', objectType: '', tag: '' };
    }

    const extractor = new EntityExtractor(store.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) {
        return { globalId: '', name: '', description: '', objectType: '', tag: '' };
    }

    const attrs = entity.attributes || [];
    // IfcRoot attributes: [GlobalId, OwnerHistory, Name, Description]
    // IfcObject adds: [ObjectType] at index 4
    // IfcProduct adds: [ObjectPlacement, Representation] at indices 5-6
    // IfcElement adds: [Tag] at index 7
    const globalId = typeof attrs[0] === 'string' ? attrs[0] : '';
    const name = typeof attrs[2] === 'string' ? attrs[2] : '';
    const description = typeof attrs[3] === 'string' ? attrs[3] : '';
    const objectType = typeof attrs[4] === 'string' ? attrs[4] : '';
    const tag = typeof attrs[7] === 'string' ? attrs[7] : '';

    return { globalId, name, description, objectType, tag };
}

/**
 * Extract ALL named entity attributes on-demand from source buffer.
 * Uses the IFC schema to map attribute indices to names.
 * Returns only string/enum attributes, skipping references and structural attributes.
 */
export function extractAllEntityAttributes(
    store: IfcDataStore,
    entityId: number
): Array<{ name: string; value: string }> {
    const ref = store.entityIndex.byId.get(entityId);
    if (!ref) return [];

    const extractor = new EntityExtractor(store.source);
    const entity = extractor.extractEntity(ref);
    if (!entity) return [];

    const attrs = entity.attributes || [];
    // Use properly-cased type name from entity table (IfcTypeEnumToString)
    // instead of ref.type which is UPPERCASE from STEP (e.g., IFCWALLSTANDARDCASE)
    // and breaks multi-word type normalization in getAttributeNames
    const typeName = store.entities.getTypeName(entityId);
    const attrNames = getAttributeNames(typeName || ref.type);

    const result: Array<{ name: string; value: string }> = [];
    const len = Math.min(attrs.length, attrNames.length);
    for (let i = 0; i < len; i++) {
        const attrName = attrNames[i];
        if (SKIP_DISPLAY_ATTRS.has(attrName)) continue;

        const raw = attrs[i];
        if (typeof raw === 'string' && raw) {
            // Clean enum values: .NOTDEFINED. -> NOTDEFINED
            const display = raw.startsWith('.') && raw.endsWith('.')
                ? raw.slice(1, -1)
                : raw;
            result.push({ name: attrName, value: display });
        }
    }

    return result;
}

// Re-export on-demand extraction functions from focused module
export {
    extractClassificationsOnDemand,
    extractMaterialsOnDemand,
    extractTypePropertiesOnDemand,
    extractTypeEntityOwnProperties,
    extractDocumentsOnDemand,
    extractRelationshipsOnDemand,
    extractGeoreferencingOnDemand,
    parsePropertyValue,
    extractPsetsFromIds,
} from './on-demand-extractors.js';

export type {
    ClassificationInfo,
    MaterialInfo,
    MaterialLayerInfo,
    MaterialProfileInfo,
    MaterialConstituentInfo,
    TypePropertyInfo,
    DocumentInfo,
    EntityRelationships,
    GeorefInfo,
} from './on-demand-extractors.js';
