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
import { getAttributeNames, getAttributeNamesAcrossSchemas, getInheritanceChain } from './ifc-schema.js';
import { parsePropertyValueWithComplex } from './on-demand-extractors.js';
import { readQuantitySet } from './quantity-collect.js';
import { buildCompactEntityIndexAsync } from './compact-entity-index.js';
import { yieldToEventLoop } from './yield-to-event-loop.js';
import {
    StringTable,
    EntityTableBuilder,
    PropertyTableBuilder,
    QuantityTableBuilder,
    RelationshipGraphBuilder,
    RelationshipType,
} from '@ifc-lite/data';
import type { SpatialHierarchy, QuantityTable, PropertyValue, PropertySet, QuantitySet, IfcStoreBase, IfcEntity, IfcAttributeValue } from '@ifc-lite/data';
import { BufferEntitySource } from './entity-source.js';
import { batchExtractGlobalIdAndName } from './columnar-parser-attributes.js';
import {
    GEOMETRY_TYPES,
    REL_TYPE_MAP,
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
import { detectSchemaVersion, parseSourceHeader } from './source-header.js';

import type { EntityByIdIndex } from './columnar-parser-indexes.js';

import { contiguousSourceBytes, type IfcSourceBytes } from './source-bytes.js';
import { getEntityRefFromStore, extractRootAttributesFromEntity, pickLongName } from './columnar-parser-root-attributes.js';
// Re-exported: part of the package's public on-demand-extraction surface
// (see packages/parser/src/index.ts).
export {
    extractEntityAttributesOnDemand,
    extractAllEntityAttributes,
    getRawNamedAttributes,
    extractRootAttributesFromEntity,
} from './columnar-parser-root-attributes.js';

// Re-export interfaces/types from extracted modules for public API compatibility
export type { SpatialIndex, EntityByIdIndex } from './columnar-parser-indexes.js';

/** Appends `ref` to `map.get(objId)`, skipping a repeat — these maps win over the deduped graph (#3760/#3782). */
function addOnDemandRef(map: Map<number, number[]>, objId: number, ref: number): void {
    const list = map.get(objId) ?? map.set(objId, []).get(objId)!;
    if (!list.includes(ref)) list.push(ref);
}

export interface IfcDataStore extends IfcStoreBase {
    parseTime: number;

    /**
     * The IFC source bytes, behind an accessor rather than a resident
     * `Uint8Array` (#2183). Read ranges with `slice`/`decodeUtf8`; use
     * `withMaterialized` for the genuine whole-file consumers, and
     * `toTransferable()` to hand it to a worker without materialising here.
     *
     * `byteLength === 0` is a supported state (server-parsed, synthetic, GLB,
     * point-cloud), and `length` is aliased so existing presence guards keep
     * their meaning.
     */
    source: IfcSourceBytes;
    entityIndex: { byId: EntityByIdIndex; byType: Map<string, number[]> };
    deferredEntityIndex?: EntityByIdIndex;

    strings: StringTable;
    entities: ReturnType<EntityTableBuilder['build']>;
    properties: ReturnType<PropertyTableBuilder['build']>;
    quantities: QuantityTable;
    relationships: ReturnType<RelationshipGraphBuilder['build']>;

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
    /** Pre-resolved classification attrs, server-parsed path only — #3955. */
    resolvedClassifications?: Map<number, import('./classification-resolver.js').ClassificationInfo[]>;

    /**
     * On-demand material lookup: entityId -> associated material definition expressIds.
     * Built from IfcRelAssociatesMaterial relationships during parsing.
     * Each value is the expressId of IfcMaterial, IfcMaterialLayerSet,
     * IfcMaterialProfileSet, IfcMaterialConstituentSet, IfcMaterialList, or a
     * *Usage. The value is a LIST so a second IfcRelAssociatesMaterial targeting
     * the same element (valid in the wild) is preserved rather than last-wins
     * overwritten — the model-wide usage index depends on seeing every one.
     */
    onDemandMaterialMap?: Map<number, number[]>;

    /**
     * On-demand document lookup: entityId -> array of IfcDocumentReference/IfcDocumentInformation expressIds
     * Built from IfcRelAssociatesDocument relationships during parsing.
     */
    onDemandDocumentMap?: Map<number, number[]>;

    /**
     * Project-level length unit scale to convert raw IFC numeric measure
     * values into base SI metres. `1.0` for metres, `0.001` for milli,
     * `0.0254` for inches, etc. Surfaced on the store so consumers
     * (notably the IDS validator, where IDS literals are always in
     * base SI units) can convert without re-parsing the unit graph.
     */
    lengthUnitScale?: number;
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
        buffer: ArrayBuffer | SharedArrayBuffer,
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

        // Capture verbatim HEADER fields so a round-trip export can reproduce
        // the source FILE_DESCRIPTION items + exact FILE_SCHEMA token instead
        // of regenerating a fresh ifc-lite header. Cheap: the scan stops at the
        // header's ENDSEC, so the DATA section is never touched.
        const sourceHeader = parseSourceHeader(uint8Buffer);

        // Schema version comes from that header's FILE_SCHEMA declaration, not
        // from a substring scan of the raw bytes — exporter product names in
        // FILE_NAME free text carry schema tokens too (issue #3278).
        const schemaVersion = detectSchemaVersion(uint8Buffer, sourceHeader);

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
        const groupRefs: EntityRef[] = [];

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
            else if (cat === CAT_GROUP) groupRefs.push(ref);
            else if (cat === CAT_RELEVANT) otherRelevantRefs.push(ref);
        }

        logPhase(`categorize ${totalEntities} → spatial:${spatialRefs.length} geom:${geometryRefs.length} rel:${relationshipRefs.length} propRel:${propertyRelRefs.length} propContainers:${propertyContainerRefs.length} propAtoms:${propertyAtomRefs.length} assocRel:${associationRelRefs.length} type:${typeObjectRefs.length} group:${groupRefs.length} other:${otherRelevantRefs.length}`);

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
            `index input: indexedRefs=${indexedRefs.length} deferredPropertyAtoms=${deferPropertyAtomIndex ? propertyAtomRefs.length : 0}`
        );

        // Keep every indexed entity available for on-demand reference resolution.
        const compactByIdIndex = await buildCompactEntityIndexAsync(indexedRefs);
        logPhase('compact entity index');

        // Create entity table builder with EXACT capacity (not totalEntities which
        // includes millions of geometry-representation entities we don't store).
        // For a 14M entity file, this reduces allocation from ~546MB to ~20MB.
        const relevantCount = spatialRefs.length + geometryRefs.length + typeObjectRefs.length
            + relationshipRefs.length + groupRefs.length + otherRelevantRefs.length;
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

        // Group family (IfcZone / IfcSystem / IfcDistributionSystem / …): small
        // count, full extract so we can resolve Name + LongName + ObjectType for
        // the group label. Name is often empty on these — the human label lives
        // in LongName (IfcZone/IfcDistributionSystem) — so fall back to it, and
        // keep ObjectType (e.g. a system designation) for richer display. (#1075)
        const groupExtra = new Map<number, { description: string; objectType: string }>();
        for (const ref of groupRefs) {
            const entity = extractor.extractEntity(ref);
            if (!entity) continue;
            const root = extractRootAttributesFromEntity(entity);
            const longName = pickLongName(entity);
            parsedEntityData.set(ref.expressId, {
                globalId: root.globalId,
                name: root.name || longName,
            });
            groupExtra.set(ref.expressId, { description: root.description, objectType: root.objectType });
        }
        logPhase('group entities');

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

        // Other relevant products (IfcSpatialZone, IfcVirtualElement, IfcGrid,
        // IfcAnnotation, …): batch GlobalId+Name so they show their Name in the
        // hierarchy / lists instead of nothing. Previously these were added to
        // the EntityTable with an empty name (parsedEntityData never covered
        // this bucket), so e.g. IfcSpatialZone listed without a label. (#1075)
        const otherData = await batchExtractGlobalIdAndName(uint8Buffer, otherRelevantRefs, yieldIfNeeded);
        for (const [id, data] of otherData) parsedEntityData.set(id, data);
        logPhase('batch other-relevant GlobalId+Name');

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
        // Groups carry Description + ObjectType (the system designation), which
        // the shared addEntityBatch drops as ''. Add them with the extra fields
        // so the Properties title / lists / lens can surface them. (#1075)
        for (const ref of groupRefs) {
            const entityData = parsedEntityData.get(ref.expressId);
            const extra = groupExtra.get(ref.expressId);
            entityTableBuilder.add(
                ref.expressId,
                ref.type,
                entityData?.globalId || '',
                entityData?.name || '',
                extra?.description || '',
                extra?.objectType || '',
                false,
                false
            );
        }
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
        // ONE accessor, shared by the store field and the entity source.
        //
        // These used to be built separately -- `BufferEntitySource` got the raw
        // `uint8Buffer` and wrapped it in its own accessor, while `source` got
        // another. That is invisible while both are resident views over the
        // same bytes, and fatal once the source can switch to compressed
        // storage in place (#2183): `getEntity` would keep reading its private
        // resident accessor, so the original buffer would never be released and
        // the store would serve entities from one representation and properties
        // from the other. Measured: with two accessors the buffer survives GC
        // after the swap; with one it is collected.
        const source = contiguousSourceBytes(uint8Buffer);
        const entitySource = new BufferEntitySource(source, entityIndex);
        const earlyStore: IfcDataStore = {
            fileSize: buffer.byteLength,
            schemaVersion,
            sourceHeader,
            entityCount: totalEntities,
            parseTime: performance.now() - startTime,
            source,
            entityIndex,
            strings,
            entities: entityTable,
            properties: propertyTable,
            quantities: quantityTable,
            relationships: hierarchyRelGraph,
            spatialHierarchy,
            lengthUnitScale,
            getEntity(expressId) { return entitySource.getEntity(expressId); },
            getEntitiesByType(typeName) { return entitySource.getEntitiesByType(typeName); },
            getProperties(expressId) { return this.properties.getForEntity(expressId); },
            getQuantities(expressId) { return this.quantities.getForEntity(expressId); },
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
                const { relatedObjects, relatingDefs } = result;
                totalPropRelObjects += relatedObjects.length;

                // RelatingPropertyDefinition is IfcPropertySetDefinitionSelect, whose
                // second alternative (IfcPropertySetDefinitionSet) is a SET of pset/
                // qset definitions — `relatingDefs` has more than one entry for that
                // case. Every entry in the group applies to every related object.
                for (const relatingDef of relatingDefs) {
                    for (const objId of relatedObjects) {
                        relationshipGraphBuilder.addEdge(relatingDef, objId, RelationshipType.DefinesByProperties, ref.expressId);
                    }

                    // Build on-demand property/quantity maps using pre-built Sets (O(1) vs binary search)
                    const isPropSet = propertySetIds.has(relatingDef);
                    const isQtySet = !isPropSet && quantitySetIds.has(relatingDef);

                    if (isPropSet || isQtySet) {
                        const targetMap = isPropSet ? onDemandPropertyMap : onDemandQuantityMap;
                        for (const objId of relatedObjects) {
                            addOnDemandRef(targetMap, objId, relatingDef);
                        }
                    }
                }
            }
        }
        await yieldIfNeeded();

        // Association rels: byte-level scanning, no addEdge (same reasoning as property rels)
        options.onProgress?.({ phase: 'parsing associations', percent: 95 });

        const onDemandClassificationMap = new Map<number, number[]>();
        const onDemandMaterialMap = new Map<number, number[]>();
        const onDemandDocumentMap = new Map<number, number[]>();
        // Determinism rule for elements with MULTIPLE IfcRelAssociatesMaterial:
        // the map keeps EVERY association (list-valued), ordered by rel express
        // id, so list[0] — the "primary" — is the RelatingMaterial of the
        // LOWEST rel express id regardless of file order. The cache rebuild
        // (viewer spatialHierarchy rebuildOnDemandMaps) applies the same rule
        // via edge relationshipIds, so fresh-parse and cache-load agree.
        const materialRelIds = new Map<number, number[]>();

        for (let i = 0; i < associationRelRefs.length; i++) {
            if ((i & 0x3FF) === 0) await yieldIfNeeded();
            const ref = associationRelRefs[i];
            const result = extractPropertyRelFast(uint8Buffer, ref.byteOffset, ref.byteLength);
            if (result) {
                // IfcRelAssociates{Material,Classification,Document}'s Relating*
                // selects are always single refs (unlike RelatingPropertyDefinition
                // above, none of IfcMaterialSelect/IfcClassificationSelect/
                // IfcDocumentSelect admit a SET alternative) — take the one entry.
                const { relatedObjects, relatingDefs } = result;
                const relatingRef = relatingDefs[0];
                const typeUpper = getTypeUpper(ref.type);

                if (typeUpper === 'IFCRELASSOCIATESCLASSIFICATION') {
                    for (const objId of relatedObjects) {
                        addOnDemandRef(onDemandClassificationMap, objId, relatingRef);
                        relationshipGraphBuilder.addEdge(relatingRef, objId, RelationshipType.AssociatesClassification, ref.expressId);
                    }
                } else if (typeUpper === 'IFCRELASSOCIATESMATERIAL') {
                    for (const objId of relatedObjects) {
                        let list = onDemandMaterialMap.get(objId);
                        let relIds = materialRelIds.get(objId);
                        if (!list || !relIds) {
                            list = []; onDemandMaterialMap.set(objId, list); relIds = []; materialRelIds.set(objId, relIds);
                        }
                        // Deliberately NOT deduped (#3782 review): buildMaterialUsageIndex
                        // already dedupes downstream (seenPerMaterial), per material-fraction-and-associations.test.ts.
                        let at = relIds.length;
                        while (at > 0 && relIds[at - 1] > ref.expressId) at--;
                        relIds.splice(at, 0, ref.expressId);
                        list.splice(at, 0, relatingRef);
                        relationshipGraphBuilder.addEdge(relatingRef, objId, RelationshipType.AssociatesMaterial, ref.expressId);
                    }
                } else if (typeUpper === 'IFCRELASSOCIATESDOCUMENT') {
                    for (const objId of relatedObjects) {
                        addOnDemandRef(onDemandDocumentMap, objId, relatingRef);
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

        const finalStore: IfcDataStore = {
            ...earlyStore,
            parseTime,
            relationships: fullRelationshipGraph,
            deferredEntityIndex,
            onDemandPropertyMap,
            onDemandQuantityMap,
            onDemandClassificationMap,
            onDemandMaterialMap,
            onDemandDocumentMap,
            lengthUnitScale,
            getEntity(expressId) { return entitySource.getEntity(expressId); },
            getEntitiesByType(typeName) { return entitySource.getEntitiesByType(typeName); },
            getProperties(expressId) {
                if (onDemandPropertyMap.size > 0) return extractPropertiesOnDemand(this as IfcDataStore, expressId) as PropertySet[];
                return this.properties.getForEntity(expressId);
            },
            getQuantities(expressId) {
                if (onDemandQuantityMap.size > 0) return extractQuantitiesOnDemand(this as IfcDataStore, expressId) as QuantitySet[];
                return this.quantities.getForEntity(expressId);
            },
        };
        return finalStore;
    }

    /**
     * Extract properties for a single entity ON-DEMAND
     * Parses only what's needed from the source buffer - instant results.
     */
    extractPropertiesOnDemand(
        store: IfcDataStore,
        entityId: number
    ): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> {
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
        const result: Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> = [];

        for (const psetId of psetIds) {
            const psetRef = getEntityRefFromStore(store, psetId);
            if (!psetRef) continue;

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

                    const propEntityRef = getEntityRefFromStore(store, propRef);
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
    ): Array<{ name: string; globalId?: string; quantities: Array<{ name: string; type: number; value: number }> }> {
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
        const result: Array<{ name: string; globalId?: string; quantities: Array<{ name: string; type: number; value: number }> }> = [];

        for (const qsetId of qsetIds) {
            const qsetRef = getEntityRefFromStore(store, qsetId);
            if (!qsetRef) continue;

            const qset = readQuantitySet(store, extractor, qsetRef);
            if (qset) result.push(qset);
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
): Array<{ name: string; globalId?: string; properties: Array<{ name: string; type: number; value: PropertyValue; values?: string[]; dataType?: string }> }> {
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
): Array<{ name: string; globalId?: string; quantities: Array<{ name: string; type: number; value: number }> }> {
    const parser = new ColumnarParser();
    return parser.extractQuantitiesOnDemand(store, entityId);
}

// Re-export on-demand extraction functions from focused module
export {
    extractClassificationsOnDemand,
    extractClassificationSystemsOnDemand,
    extractMaterialsOnDemand,
    extractAllMaterialsOnDemand,
    extractMaterialPropertiesOnDemand,
    extractMaterialPropertiesForMaterialId,
    resolveMaterialDefId,
    resolveAllMaterialDefIds,
    collectMaterialLeaves,
    buildMaterialUsageIndex,
    getMaterialDisplay,
    extractTypePropertiesOnDemand,
    extractTypeEntityOwnProperties,
    extractTypeQuantitiesOnDemand,
    extractDocumentsOnDemand,
    extractRelationshipsOnDemand,
    extractGroupMembersOnDemand,
    extractGeoreferencingOnDemand,
    parsePropertyValue,
    extractPsetsFromIds,
    extractQsetsFromIds,
} from './on-demand-extractors.js';

export { mergeInheritedPropertySets, mergeInheritedQuantitySets } from './property-set-merge.js';

export type {
    ClassificationInfo,
    ClassificationSystemNames,
    MaterialInfo,
    MaterialLayerInfo,
    MaterialProfileInfo,
    MaterialConstituentInfo,
    MaterialPsetGroup,
    MaterialLeaf,
    MaterialUsage,
    TypePropertyInfo,
    TypeQuantityInfo,
    DocumentInfo,
    EntityRelationships,
    GroupMember,
    GeorefInfo,
} from './on-demand-extractors.js';
