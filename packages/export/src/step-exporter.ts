/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC STEP file exporter
 *
 * Exports IFC data store to ISO 10303-21 STEP format.
 * Supports applying property and root attribute mutations before export.
 */

import type { IfcDataStore, IfcAttributeValue, IfcSourceHeader } from '@ifc-lite/parser';
import {
  EntityExtractor,
  generateHeader,
  parseSourceHeader,
  getAttributeNamesAcrossSchemas,
  serializeValue,
  ref,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { safeUtf8Decode } from '@ifc-lite/data';
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { retypeStepLine, retypeArgTokens } from './retype.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
import { authoredEntityRefs, getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import {
  HAS_PROPERTY_SETS_SLOT,
  hasPropertySetsToken,
  isTypeClass,
  resolveTypeOwnedPsetIds,
} from './type-owned-psets.js';
import {
  escapeStepString,
  toStepReal,
  quantityTypeToIfcType,
  serializePropertyValue,
  serializeAttributeValue,
  serializeStepValue,
  tokenIsRealLiteral,
  splitTopLevelArgs,
  splitTopLevelStepArguments,
  assembleStepBytes,
} from './step-serialization.js';
import { getRealTypedSlots, serializeEntityArgs, serializeAttributeSlot, isTypedMarker } from './attribute-real-slots.js';
import {
  getEnumTypedSlots,
  getStringTypedSlots,
  serializeEnumToken,
  serializeStringSlot,
} from './attribute-slot-types.js';
import { serializeQualifiedSelectSlot } from './select-qualification.js';

/** `OwnerHistory` is slot 1 on every `IfcRoot` subtype, all schemas. */
const OWNER_HISTORY_SLOT = 1;

/**
 * Options for STEP export
 */
export interface StepExportOptions {
  /** IFC schema version for the output file (any version, will convert if needed) */
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  /** File description */
  description?: string;
  /** Author name */
  author?: string;
  /** Organization name */
  organization?: string;
  /** Application name (defaults to 'ifc-lite') */
  application?: string;
  /** Output filename */
  filename?: string;

  /** Include original geometry entities (default: true) */
  includeGeometry?: boolean;
  /** Include property sets (default: true) */
  includeProperties?: boolean;
  /** Include quantity sets (default: true) */
  includeQuantities?: boolean;
  /** Include relationships (default: true) */
  includeRelationships?: boolean;

  /** Apply mutations from MutablePropertyView (default: true if provided) */
  applyMutations?: boolean;
  /** Only export entities with mutations (delta export) */
  deltaOnly?: boolean;

  /** Only export entities currently visible in the viewer */
  visibleOnly?: boolean;
  /** Hidden entity IDs (local expressIds) — required when visibleOnly is true */
  hiddenEntityIds?: Set<number>;
  /** Isolated entity IDs (local expressIds, null = no isolation active) */
  isolatedEntityIds?: Set<number> | null;

  /** Georeferencing mutations to apply (IfcProjectedCRS / IfcMapConversion edits) */
  georefMutations?: {
    projectedCRS?: Partial<ProjectedCRS>;
    mapConversion?: Partial<MapConversion>;
  };

  /**
   * Seeded randomness for the GlobalIds this exporter SYNTHESIZES:
   * the `IfcPropertySet` / `IfcElementQuantity` roots regenerated for
   * mutated (or overlay-created) property and quantity sets, their
   * `IfcRelDefinesByProperties` links, and any `IFCPROXY` placeholder minted
   * by schema conversion. Without it those come from the platform CSPRNG, so
   * two exports of the same model differ in exactly those bytes - which
   * breaks byte-reproducibility for in-store builds that call
   * `addPropertySet` / `addQuantitySet` (the sets themselves live in the
   * mutation overlay and only become IFC roots here). Pass the same seeded
   * source used for `SpatialAnchor.guidRandom` to close that gap. Default
   * (omitted) behaviour is unchanged: random.
   */
  guidRandom?: RandomSource;
  /**
   * Pin the STEP header `FILE_NAME` timestamp (STEP format, e.g.
   * `20240101T000000`). Omitted = the wall clock, as before. Required for
   * genuinely byte-identical exports, since the header otherwise carries the
   * export instant.
   */
  timeStamp?: string;

  /** Progress callback for async export */
  onProgress?: (progress: StepExportProgress) => void;
}

/**
 * Progress information during STEP export
 */
export interface StepExportProgress {
  /** Current phase of export */
  phase: 'preparing' | 'entities' | 'assembling';
  /** Progress 0-1 */
  percent: number;
  /** Number of entities processed so far */
  entitiesProcessed: number;
  /** Total entities to process */
  entitiesTotal: number;
}

/**
 * Result of STEP export
 */
export interface StepExportResult {
  /** STEP file content as bytes (avoids V8 string length limit for large files) */
  content: Uint8Array;
  /** Statistics about the export */
  stats: {
    /** Total entities exported */
    entityCount: number;
    /** New entities created for mutations */
    newEntityCount: number;
    /** Entities modified by mutations */
    modifiedEntityCount: number;
    /** File size in bytes */
    fileSize: number;
    /**
     * Non-fatal refusals: things the caller asked for that this export could
     * not write. Empty when the export did everything it was asked to do.
     *
     * A requested `georefMutations.mapConversion` is the one case today: with
     * no `IfcGeometricRepresentationContext` to reference as `SourceCRS`, the
     * `IfcMapConversion` is skipped (writing it would produce a dangling
     * reference) while the `IfcProjectedCRS` is still written — so the output
     * is indistinguishable from "no map conversion was requested" unless the
     * caller reads this (#2067). Same `string[]` shape as
     * `MergeExportResult.stats.warnings`.
     */
    warnings: string[];
  };
}

/**
 * Message for the one refusal `export()` can report, shared by the returned
 * `stats.warnings` entry and the console line so the two cannot drift.
 */
const MAP_CONVERSION_WITHOUT_CONTEXT_WARNING =
  'Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The requested IfcProjectedCRS was written without it.';

/**
 * IFC STEP file exporter
 */
export class StepExporter {
  private dataStore: IfcDataStore;
  private mutationView: MutablePropertyView | null;
  private nextExpressId: number;
  private entityExtractor: EntityExtractor | null;
  /** Lazily-resolved fallback `#id` of an IfcOwnerHistory that survives the
   *  current export closure (or `$` when the file has none). */
  private ownerHistoryFallbackRef: string | undefined;
  /** Per-host cache of an element's own OwnerHistory ref (`#id` or null). */
  private ownerHistoryByEntity = new Map<number, string | null>();

  constructor(dataStore: IfcDataStore, mutationView?: MutablePropertyView) {
    this.dataStore = dataStore;
    this.mutationView = mutationView || null;
    const maxExisting = this.findMaxExpressId();
    const overlayWatermark = typeof mutationView?.peekNextExpressId === 'function'
      ? mutationView.peekNextExpressId() - 1
      : 0;
    this.nextExpressId = Math.max(maxExisting, overlayWatermark) + 1;
    this.entityExtractor = dataStore.source ? new EntityExtractor(dataStore.source) : null;
  }

  /**
   * Export to STEP format
   */
  export(options: StepExportOptions): StepExportResult {
    const entities: string[] = [];
    let newEntityCount = 0;
    let modifiedEntityCount = 0;
    // Both owner-history caches are per-EXPORT, not per-exporter: they now
    // depend on `willBeEmitted`, which depends on this call's options. Reusing
    // one exporter for a `visibleOnly` export and then a full one would
    // otherwise answer the second from the first one's closure.
    this.ownerHistoryFallbackRef = undefined;
    this.ownerHistoryByEntity.clear();

    // Determine target schema from options, source schema from data store
    const schema = options.schema || (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const sourceSchema = (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const converting = needsConversion(sourceSchema, schema);

    if (
      schema === 'IFC2X3' &&
      options.applyMutations !== false &&
      options.georefMutations &&
      (
        Object.keys(options.georefMutations.projectedCRS ?? {}).length > 0 ||
        Object.keys(options.georefMutations.mapConversion ?? {}).length > 0
      )
    ) {
      throw new Error('Georeferencing creation and editing requires IFC4 or newer. IFC2X3 does not support IfcProjectedCRS or IfcMapConversion.');
    }

    // Round-trip header fidelity: prefer the verbatim source HEADER fields so
    // a re-export reproduces the original FILE_DESCRIPTION items + exact
    // FILE_SCHEMA token instead of a fresh ifc-lite header. The parser stores
    // `sourceHeader`; fall back to parsing the (always-present) source bytes so
    // cache-restored stores — which don't carry `sourceHeader` — still work.
    const sourceHeader: IfcSourceHeader | undefined =
      this.dataStore.sourceHeader
      ?? (this.dataStore.source ? parseSourceHeader(this.dataStore.source) : undefined);

    // Preserve the exact FILE_SCHEMA identifier (e.g. IFC4X3_ADD2) only when we
    // are NOT converting schemas; conversion must emit the coarse target token.
    const schemaToken: string =
      !converting && sourceHeader?.schemaIdentifiers?.[0]
        ? sourceHeader.schemaIdentifiers[0]
        : schema;

    // Built once entity counts are known, so the provenance item can report the
    // actual modification count. See the two call sites (empty delta + final).
    const buildHeader = (modifications: number): string => {
      // FILE_DESCRIPTION items: an explicit option wins, else the source items
      // verbatim, else the generic default.
      const description: string[] =
        options.description !== undefined
          ? [options.description]
          : sourceHeader && sourceHeader.description.length > 0
            ? [...sourceHeader.description]
            : ['Exported from ifc-lite'];
      // Honest provenance: never claim untouched source output. Append (never
      // overwrite) one item when ifc-lite actually changed the file.
      if (modifications > 0) {
        description.push(
          `Re-exported by ifc-lite, ${modifications} modification${modifications === 1 ? '' : 's'}`,
        );
      }
      return generateHeader({
        schema: schemaToken,
        description,
        implementationLevel: sourceHeader?.implementationLevel,
        author: options.author ?? sourceHeader?.author,
        organization: options.organization ?? sourceHeader?.organization,
        // preprocessor_version = the tool that WROTE this file (ifc-lite);
        // originating_system keeps the source authoring tool so it isn't erased.
        preprocessorVersion: options.application ?? 'ifc-lite',
        originatingSystem: sourceHeader?.originatingSystem,
        authorization: sourceHeader?.authorization,
        application: options.application ?? 'ifc-lite',
        filename: options.filename ?? 'export.ifc',
        timeStamp: options.timeStamp,
      });
    };

    // The one authority for exists / class / deleted, overlay first and source
    // buffer second. Every pass below asks this instead of `this.dataStore`,
    // which answers only for the file as parsed (#2012).
    const effective = getEffectiveEntityIndex(
      this.dataStore,
      this.mutationView,
      options.applyMutations !== false,
    );

    // Does this id belong to an entity the OVERLAY created (`createEntity` /
    // `store.addEntity`) rather than to a record in the source buffer? Such an
    // entity has no source bytes, so the source-iteration pass below never sees
    // it and the new-entities pass at the end owns its line entirely (#2006).
    const isOverlayCreated = (entityId: number): boolean => effective.isOverlayCreated(entityId);

    // Collect entities that need to be modified or created
    const modifiedEntities = new Set<number>();
    const modifiedPsets = new Map<number, Set<string>>(); // entityId -> psetNames being modified
    const modifiedAttributes = new Map<number, Map<string, string>>();
    const newPropertySets: Array<{ entityId: number; psets: PropertySet[] }> = [];
    const newQuantitySets: Array<{ entityId: number; qsets: QuantitySet[] }> = [];
    const typeOwnedPsetNamesByEntity = new Map<number, Set<string>>();
    const typeOwnedPsetIdsByEntity = new Map<number, number[]>();
    const rewrittenEntityIds = new Set<number>();
    const rewrittenEntityLines = new Map<number, string>();
    /** HasPropertySets slot value for an OVERLAY-CREATED type object, applied
     *  by the new-entities pass (there is no source line to rewrite). */
    const overlayTypeOwnedPsets = new Map<number, IfcAttributeValue>();

    // Track property set IDs and relationship IDs to skip
    const skipPropertySetIds = new Set<number>();
    const skipRelationshipIds = new Set<number>();

    const overlayActive = !!this.mutationView && (options.applyMutations !== false);

    // Process mutations if we have a mutation view
    if (this.mutationView && (options.applyMutations !== false)) {
      const mutations = this.mutationView.getMutations();

      // Attribute values come from the *overlay*, never from the mutation
      // history. The history is append-only and undo writes its reverse edit
      // with `skipHistory: true`, so a superseded UPDATE_ATTRIBUTE record keeps
      // its stale `newValue` forever — replaying it resurrects edits the user
      // undid (#1957). The overlay is what the editor shows, and it is already
      // the source for psets, quantities, positional attributes and retypes
      // below, so attributes were the sole outlier.
      for (const [entityId, attrs] of this.mutationView.getAttributeMutationsByEntity()) {
        modifiedEntities.add(entityId);
        let target = modifiedAttributes.get(entityId);
        if (!target) {
          target = new Map();
          modifiedAttributes.set(entityId, target);
        }
        for (const [name, value] of attrs) target.set(name, value);
      }

      // Group mutations by entity, separating property vs quantity mutations
      const entityPropMutations = new Map<number, Set<string>>();
      const entityQuantMutations = new Map<number, Set<string>>();
      for (const mutation of mutations) {
        // Handled above, off the overlay. Skipped explicitly because an
        // UPDATE_ATTRIBUTE record can also carry a `psetName` (georef fields
        // encode their target entity there) and must not be mistaken for a
        // property-set edit.
        if (mutation.type === 'UPDATE_ATTRIBUTE') continue;

        if (!mutation.psetName) continue;

        const isQuantity = mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY' || mutation.type === 'DELETE_QUANTITY';
        const targetMap = isQuantity ? entityQuantMutations : entityPropMutations;

        if (!targetMap.has(mutation.entityId)) {
          targetMap.set(mutation.entityId, new Set());
        }
        targetMap.get(mutation.entityId)!.add(mutation.psetName);
      }

      // Build a reverse index of IfcRelDefinesByProperties → (relId, psetId)
      // pairs keyed on each related entity. The two property/quantity loops
      // below previously walked every entity in `entityIndex.byId` per
      // modified entity (O(E·N)); the index keeps the per-entity step
      // O(K) where K is the number of rels referencing that entity.
      const { byEntity: relDefinesByEntity, relatedByRel } = this.buildRelDefinesByPropertiesIndex();

      // A source IfcRelDefinesByProperties whose EVERY related object the
      // session deleted has nothing left to relate, and emitting it leaves a
      // `#id` pointing at a record the export skipped. Dropped only when all of
      // them are gone: a rel that still names a live entity is that entity's
      // only link to its psets, and nothing here rewrites a RelatedObjects list.
      for (const [relId, related] of relatedByRel) {
        if (related.length > 0 && related.every((id) => effective.isDeleted(id))) {
          skipRelationshipIds.add(relId);
        }
      }

      // Collect modified property sets and find original psets to skip
      for (const [entityId, psetNames] of entityPropMutations) {
        // A deleted entity must not cause the exporter to REMOVE anything.
        //
        // This is the other half of the dangling-reference class, and the half
        // `willBeEmitted` cannot reach: that predicate guards what gets ADDED,
        // and this loop's real work is deciding what gets SKIPPED. An edited
        // pset is replaced wholesale, so its original id goes into
        // `skipPropertySetIds` — but IFC exporters share one IfcPropertySet
        // between entities, and once the host is deleted there is no
        // replacement to take its place. The surviving entity's relation then
        // points at a container nobody wrote. Verified against main at
        // e6516991 (#2030's own merge): edit `Pset_WallCommon` on one of two
        // walls sharing it, delete that wall, and the export drops #11 while
        // #12 still names it. `retainSharedAtoms` rescues a shared ATOM one
        // level down; nothing rescues the shared container.
        //
        // Leaving the pset alone makes it an orphan when nothing else
        // references it, which is valid IFC. Its relation is dropped by the
        // sweep above, which handles a plain delete too — no pset edit needed.
        if (effective.isDeleted(entityId)) continue;
        modifiedEntities.add(entityId);
        modifiedPsets.set(entityId, psetNames);
        // Same rule as the attribute loop below: an overlay-CREATED entity is
        // emitted once, by the new-entities pass, and already counted in
        // `newEntityCount` — as are the pset entities this loop goes on to
        // generate. Only the COUNT is guarded; the entity still records its
        // pset edits and still emits them.
        if (!isOverlayCreated(entityId)) modifiedEntityCount++;

        // Get the FULL mutated property sets for this entity (merged base + mutations)
        const allPsets = this.mutationView.getForEntity(entityId);
        const relevantPsets = allPsets.filter((pset: PropertySet) => psetNames.has(pset.name));
        const relDefinedPsetNames = new Set<string>();

        if (relevantPsets.length > 0) {
          newPropertySets.push({ entityId, psets: relevantPsets });
        }

        // Find original property set IDs and relationship IDs to skip — look
        // up only the IfcRelDefinesByProperties rels that reference this entity.
        const rels = relDefinesByEntity.get(entityId);
        if (rels) {
          for (const { relId, psetId: relatedPsetId } of rels) {
            // Check if this pset is one we're modifying
            const psetName = this.getPropertySetName(relatedPsetId);
            if (psetName) {
              relDefinedPsetNames.add(psetName);
            }
            if (psetName && psetNames.has(psetName)) {
              skipRelationshipIds.add(relId);
              skipPropertySetIds.add(relatedPsetId);
              // Also skip the individual properties in this pset
              const propIds = this.getPropertyIdsInSet(relatedPsetId);
              for (const propId of propIds) {
                skipPropertySetIds.add(propId);
              }
            }
          }
        }

        if (isTypeClass(effective.typeOf(entityId))) {
          const typeOwnedPsetIds = this.getTypeOwnedHasPropertySetIds(entityId, effective);
          const typeOwnedAffected = new Set<string>();

          for (const psetId of typeOwnedPsetIds) {
            const psetName = this.getPropertySetName(psetId);
            if (!psetName || !psetNames.has(psetName)) continue;
            typeOwnedAffected.add(psetName);
            skipPropertySetIds.add(psetId);
            const propIds = this.getPropertyIdsInSet(psetId);
            for (const propId of propIds) {
              skipPropertySetIds.add(propId);
            }
          }

          for (const psetName of psetNames) {
            if (!relDefinedPsetNames.has(psetName)) {
              typeOwnedAffected.add(psetName);
            }
          }

          if (typeOwnedAffected.size > 0) {
            typeOwnedPsetNamesByEntity.set(entityId, typeOwnedAffected);
            typeOwnedPsetIdsByEntity.set(entityId, typeOwnedPsetIds);
            rewrittenEntityIds.add(entityId);
          }
        }
      }

      // Collect modified quantity sets (only if quantities are included)
      if (options.includeQuantities === false) entityQuantMutations.clear();
      for (const [entityId, qsetNames] of entityQuantMutations) {
        // Same rule as the property loop above: a deleted entity removes nothing.
        if (effective.isDeleted(entityId)) continue;
        modifiedEntities.add(entityId);
        // See the property loop above — an overlay-created entity is counted as
        // new, not modified.
        if (!isOverlayCreated(entityId) && !modifiedPsets.has(entityId)) modifiedEntityCount++;

        const allQsets = this.mutationView.getQuantitiesForEntity(entityId);
        const relevantQsets = allQsets.filter((qset: QuantitySet) => qsetNames.has(qset.name));

        if (relevantQsets.length > 0) {
          newQuantitySets.push({ entityId, qsets: relevantQsets });
        }

        // Skip original quantity set entities (IfcElementQuantity).
        // Same per-entity index lookup as the property branch above.
        const rels = relDefinesByEntity.get(entityId);
        if (rels) {
          for (const { relId, psetId: relatedPsetId } of rels) {
            const qsetName = this.getElementQuantityName(relatedPsetId);
            if (qsetName && qsetNames.has(qsetName)) {
              skipRelationshipIds.add(relId);
              skipPropertySetIds.add(relatedPsetId);
              const quantIds = this.getPropertyIdsInSet(relatedPsetId);
              for (const quantId of quantIds) {
                skipPropertySetIds.add(quantId);
              }
            }
          }
        }
      }

      for (const [entityId] of modifiedAttributes) {
        // An overlay-CREATED entity carrying attribute edits is emitted once,
        // by the new-entities pass, and already counted in `newEntityCount`.
        // Counting it here too made the header claim two affected entities for
        // one created-then-renamed wall.
        if (isOverlayCreated(entityId)) continue;
        if (!entityPropMutations.has(entityId) && !entityQuantMutations.has(entityId)) {
          modifiedEntityCount++;
        }
      }
    }

    // Process georeferencing mutations (only when applyMutations is enabled)
    const newGeorefLines: string[] = [];
    const warnings: string[] = [];
    if (options.applyMutations !== false && options.georefMutations) {
      const gm = options.georefMutations;
      const existingCrsIds = this.dataStore.entityIndex.byType.get('IFCPROJECTEDCRS');
      const existingMcIds = this.dataStore.entityIndex.byType.get('IFCMAPCONVERSION');

      // Modify existing IfcProjectedCRS
      if (gm.projectedCRS && existingCrsIds?.length) {
        const entityId = existingCrsIds[0];
        if (!modifiedAttributes.has(entityId)) {
          modifiedAttributes.set(entityId, new Map());
        }
        const attrMap = modifiedAttributes.get(entityId)!;
        const crs = gm.projectedCRS;
        let changed = false;
        if (crs.name !== undefined) { attrMap.set('Name', String(crs.name)); changed = true; }
        if (crs.description !== undefined) { attrMap.set('Description', String(crs.description)); changed = true; }
        if (crs.geodeticDatum !== undefined) { attrMap.set('GeodeticDatum', String(crs.geodeticDatum)); changed = true; }
        if (crs.verticalDatum !== undefined) { attrMap.set('VerticalDatum', String(crs.verticalDatum)); changed = true; }
        if (crs.mapProjection !== undefined) { attrMap.set('MapProjection', String(crs.mapProjection)); changed = true; }
        if (crs.mapZone !== undefined) { attrMap.set('MapZone', String(crs.mapZone)); changed = true; }
        if (crs.mapUnit !== undefined) {
          const mapUnitRef = this.resolveMapUnitReference(String(crs.mapUnit), newGeorefLines);
          attrMap.set('MapUnit', `#${mapUnitRef}`);
          changed = true;
        }
        if (changed && !modifiedEntities.has(entityId)) {
          modifiedEntities.add(entityId);
          modifiedEntityCount++;
        }
      }

      // Modify existing IfcMapConversion
      if (gm.mapConversion && existingMcIds?.length) {
        const entityId = existingMcIds[0];
        if (!modifiedAttributes.has(entityId)) {
          modifiedAttributes.set(entityId, new Map());
        }
        const attrMap = modifiedAttributes.get(entityId)!;
        const mc = gm.mapConversion;
        let changed = false;
        if (mc.eastings !== undefined) { attrMap.set('Eastings', String(mc.eastings)); changed = true; }
        if (mc.northings !== undefined) { attrMap.set('Northings', String(mc.northings)); changed = true; }
        if (mc.orthogonalHeight !== undefined) { attrMap.set('OrthogonalHeight', String(mc.orthogonalHeight)); changed = true; }
        if (mc.xAxisAbscissa !== undefined) { attrMap.set('XAxisAbscissa', String(mc.xAxisAbscissa)); changed = true; }
        if (mc.xAxisOrdinate !== undefined) { attrMap.set('XAxisOrdinate', String(mc.xAxisOrdinate)); changed = true; }
        if (mc.scale !== undefined) { attrMap.set('Scale', String(mc.scale)); changed = true; }
        if (changed && !modifiedEntities.has(entityId)) {
          modifiedEntities.add(entityId);
          modifiedEntityCount++;
        }
      }

      // CREATE new georef entities when file has none
      if (gm.projectedCRS && !existingCrsIds?.length) {
        const crs = gm.projectedCRS;
        const crsId = this.nextExpressId++;
        // IfcProjectedCRS(Name, Description, GeodeticDatum, VerticalDatum, MapProjection, MapZone, MapUnit)
        const name = crs.name ? `'${escapeStepString(String(crs.name))}'` : '$';
        const desc = crs.description ? `'${escapeStepString(String(crs.description))}'` : '$';
        const datum = crs.geodeticDatum ? `'${escapeStepString(String(crs.geodeticDatum))}'` : '$';
        const vDatum = crs.verticalDatum ? `'${escapeStepString(String(crs.verticalDatum))}'` : '$';
        const proj = crs.mapProjection ? `'${escapeStepString(String(crs.mapProjection))}'` : '$';
        const zone = crs.mapZone ? `'${escapeStepString(String(crs.mapZone))}'` : '$';
        const mapUnitRef = crs.mapUnit
          ? `#${this.resolveMapUnitReference(String(crs.mapUnit), newGeorefLines)}`
          : '$';
        newGeorefLines.push(`#${crsId}=IFCPROJECTEDCRS(${name},${desc},${datum},${vDatum},${proj},${zone},${mapUnitRef});`);
        newEntityCount++;

        // Find IfcGeometricRepresentationContext as SourceCRS for MapConversion
        const contextId = this.findPreferredGeometricRepresentationContextId();

        if (contextId) {
          const mc = gm.mapConversion || {};
          const mcId = this.nextExpressId++;
          const eastings = toStepReal(Number(mc.eastings) || 0);
          const northings = toStepReal(Number(mc.northings) || 0);
          const height = toStepReal(Number(mc.orthogonalHeight) || 0);
          const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
          const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
          const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
          // IfcMapConversion(SourceCRS, TargetCRS, Eastings, Northings, OrthogonalHeight, XAxisAbscissa, XAxisOrdinate, Scale)
          newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${crsId},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
          newEntityCount++;
        } else {
          this.reportMapConversionRefused(warnings);
        }
      } else if (gm.mapConversion && !existingMcIds?.length && existingCrsIds?.length) {
        // CRS exists but no MapConversion — create just the conversion
        const contextId = this.findPreferredGeometricRepresentationContextId();
        if (contextId) {
          const mc = gm.mapConversion;
          const mcId = this.nextExpressId++;
          const eastings = toStepReal(Number(mc.eastings) || 0);
          const northings = toStepReal(Number(mc.northings) || 0);
          const height = toStepReal(Number(mc.orthogonalHeight) || 0);
          const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
          const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
          const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
          newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${existingCrsIds[0]},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
          newEntityCount++;
        } else {
          this.reportMapConversionRefused(warnings);
        }
      }
    }

    // If delta only, only export modified entities. Overlay-created entities
    // also count — without this, `createEntity()`-only edits would silently
    // drop out of delta exports.
    const overlayNewEntityCount = (
      this.mutationView
      && options.applyMutations !== false
      && typeof this.mutationView.getNewEntities === 'function'
    ) ? this.mutationView.getNewEntities().length : 0;
    // Georef-only deltas (newGeorefLines populated but no entity changes) must
    // still produce a non-empty DATA section.
    if (
      options.deltaOnly
      && modifiedEntities.size === 0
      && overlayNewEntityCount === 0
      && newGeorefLines.length === 0
    ) {
      const emptyContent = new TextEncoder().encode(buildHeader(0) + 'DATA;\nENDSEC;\nEND-ISO-10303-21;\n');
      return {
        content: emptyContent,
        stats: {
          entityCount: 0,
          newEntityCount: 0,
          modifiedEntityCount: 0,
          fileSize: emptyContent.byteLength,
          warnings,
        },
      };
    }

    // Build visible-only closure if requested. Classification, the closure walk
    // and the style pass all run over the EFFECTIVE index: an overlay-created
    // product becomes a root by the same type rules as a parsed one, the walk
    // follows its authored references into the geometry it alone owns, and a
    // tombstoned entity is simply not there. Run over the source buffer, a
    // created wall could never be a root and nothing referenced it, so
    // `visibleOnly` wrote a file without it and said nothing (#2012).
    let allowedEntityIds: Set<number> | null = null;
    if (options.visibleOnly && this.dataStore.source) {
      const { roots, hiddenProductIds } = getVisibleEntityIds(
        this.dataStore,
        options.hiddenEntityIds ?? new Set(),
        options.isolatedEntityIds ?? null,
        effective,
      );
      allowedEntityIds = collectReferencedEntityIds(
        roots,
        this.dataStore.source,
        effective,
        hiddenProductIds,
      );
      // Second pass: collect IFCSTYLEDITEM entities that reference included
      // geometry. Styled items reference geometry items but nothing references
      // them back, so the forward closure misses them.
      collectStyleEntities(
        allowedEntityIds,
        this.dataStore.source,
        { byId: effective, byType: effective.byType },
      );
    }

    /**
     * Will this id have a defining STEP line in the output at all?
     *
     * The predicate is #2030's, and it is the right one: the pset, quantity and
     * type-owned passes below are built from unfiltered mutation history, and
     * what each of them needs to know before emitting an
     * `IFCRELDEFINESBYPROPERTIES` is not "was this deleted" or "is this hidden"
     * but the general question those are two answers to. A relation naming an
     * expressId that never gets written is a dangling reference and an invalid
     * file, whichever route dropped the line.
     *
     * #2030 had to reach for four things to answer it — a tombstone probe, a
     * visibility set, a byte-range test on `completeIndex`, and a `getNewEntity`
     * fallback whose stated purpose was that `deleteEntity` FORGOT an
     * overlay-created entity instead of tombstoning it, so `isDeleted` could not
     * answer for one. That fallback was documented on main as a workaround for
     * exactly the model-level defect this branch fixes: `deleteEntity` now
     * tombstones as well as forgets, so the effective index answers existence
     * for source and overlay ids alike and the workaround collapses into it.
     *
     * The overlay branch does NOT disappear with it, and the distinction matters:
     * `isOverlayCreated` is still load-bearing here, because a live
     * overlay-created entity has no source bytes and would fail the byte-range
     * test that a source record passes. What the tombstone fix removed is the
     * need for that branch to double as a deletion detector.
     *
     * Deliberately unchanged from #2030 for source records under `deltaOnly` /
     * `exportPropertiesOnly`: the source-iteration pass is skipped wholesale in
     * those modes, yet a source entity still answers true here. A delta is a
     * patch against a file that already has the line, not a standalone model.
     */
    const willBeEmitted = (entityId: number): boolean => {
      if (allowedEntityIds !== null && !allowedEntityIds.has(entityId)) return false;
      // Undefined for a tombstoned id and for one neither the file nor the
      // session ever had — a stale mutation must not conjure a relation either.
      const ref = effective.get(entityId);
      if (!ref) return false;
      // An overlay-created record carries the placeholder byte range and is
      // written by the new-entities pass; a source record needs real bytes.
      return effective.isOverlayCreated(entityId) || (ref.byteLength > 0 && ref.byteOffset >= 0);
    };

    // A modified pset is replaced wholesale, which skips ALL of its member atoms.
    // But IFC exporters deduplicate identical Pset_*Common atoms (e.g. one
    // IsExternal IfcPropertySingleValue shared by dozens of psets), so skipping a
    // shared atom would orphan every OTHER pset that still references it, leaving
    // dangling refs and an invalid file. Keep any atom a surviving container needs.
    this.retainSharedAtoms(skipPropertySetIds, allowedEntityIds);

    // Export original entities from source buffer, SKIPPING modified property sets
    if (!options.deltaOnly && this.dataStore.source) {
      const source = this.dataStore.source;

      // Extract existing entities from source. The effective index has already
      // dropped everything the overlay tombstoned, so there is no separate
      // deleted check to forget here.
      for (const [expressId, entityRef] of effective) {
        // Skip overlay-only entities — emitted by the new-entities pass below
        if (entityRef.byteLength === 0 || entityRef.byteOffset < 0) {
          continue;
        }

        // Skip entities outside the visible closure
        if (allowedEntityIds !== null && !allowedEntityIds.has(expressId)) {
          continue;
        }

        // Skip property sets/relationships that are being replaced
        if (skipPropertySetIds.has(expressId) || skipRelationshipIds.has(expressId)) {
          continue;
        }

        // Skip type entities whose HasPropertySets attribute will be rewritten
        if (rewrittenEntityIds.has(expressId)) {
          continue;
        }

        // Skip if we're only doing geometry or specific types
        const entityType = entityRef.type.toUpperCase();

        // Skip geometry if not included
        if (options.includeGeometry === false && this.isGeometryEntity(entityType)) {
          continue;
        }

        // Get original entity text — safeUtf8Decode handles SAB-backed
        // sources (Firefox/Chrome reject `TextDecoder.decode()` on a
        // SharedArrayBuffer-backed view; the parser deliberately keeps
        // `source` zero-copy SAB-backed for worker sharing).
        const entityText = safeUtf8Decode(
          source,
          entityRef.byteOffset,
          entityRef.byteOffset + entityRef.byteLength
        );
        let nextEntityText = entityText;

        // Entity retype (reassign class) runs FIRST so attribute mutations
        // below resolve against the TARGET class's attribute names. The
        // expressId is unchanged, so geometry / placement / representation and
        // every IfcRel* reference (keyed by #id) carry over untouched.
        //
        // This materializes inside the source-iteration loop, which `deltaOnly`
        // skips — so, like in-place attribute/positional edits to existing
        // entities, an existing-entity retype is only emitted by a full export
        // (the common `applyMutations` path). Retyped OVERLAY-created entities
        // are emitted under `deltaOnly` via the new-entities pass below.
        const typeMutation = overlayActive && typeof this.mutationView!.getEntityTypeMutation === 'function'
          ? this.mutationView!.getEntityTypeMutation(expressId)
          : null;
        let workingType = entityType;
        if (typeMutation) {
          nextEntityText = retypeStepLine(
            nextEntityText,
            entityRef.type,
            typeMutation.newType,
            typeMutation.predefinedType ?? null,
            sourceSchema,
          );
          workingType = typeMutation.newType.toUpperCase();
          if (!modifiedEntities.has(expressId)) {
            modifiedEntities.add(expressId);
            modifiedEntityCount++;
          }
        }

        if (modifiedAttributes.has(expressId)) {
          nextEntityText = this.applyAttributeMutations(nextEntityText, workingType, modifiedAttributes.get(expressId)!);
        }

        const positional = overlayActive && typeof this.mutationView!.getPositionalMutationsForEntity === 'function'
          ? this.mutationView!.getPositionalMutationsForEntity(expressId)
          : null;
        if (positional && positional.size > 0) {
          nextEntityText = this.applyPositionalMutations(nextEntityText, positional, workingType, sourceSchema);
          if (!modifiedEntities.has(expressId)) {
            modifiedEntities.add(expressId);
            modifiedEntityCount++;
          }
        }

        // Apply schema conversion if exporting to a different schema version
        if (converting) {
          const converted = convertStepLine(nextEntityText, sourceSchema, schema, options.guidRandom);
          if (converted !== null) {
            entities.push(converted);
          }
          // null means entity should be skipped (no valid representation in target schema)
        } else {
          entities.push(nextEntityText);
        }
      }
    }

    // Generate new property entities for mutations (these REPLACE the skipped ones)
    const generatedTypeOwnedPsetIds = new Map<number, Map<string, number>>();
    for (const { entityId, psets } of newPropertySets) {
      // Nothing may be emitted FOR an entity that gets no defining line —
      // see `willBeEmitted` (#1978, #2030, #2012).
      if (!willBeEmitted(entityId)) continue;
      const newEntities = this.generatePropertySetEntities(
        entityId,
        psets,
        willBeEmitted,
        typeOwnedPsetNamesByEntity.get(entityId),
        options.guidRandom
      );
      entities.push(...newEntities.lines);
      newEntityCount += newEntities.count;
      generatedTypeOwnedPsetIds.set(entityId, newEntities.generatedTypeOwnedPsetIds);
    }

    // Point every affected type object's HasPropertySets at the psets this
    // export generated. One loop, because a type whose affected psets produced
    // no replacement content (a deletion) needs exactly the same resolution
    // with an empty replacement map.
    for (const [entityId, typeOwnedPsetNames] of typeOwnedPsetNamesByEntity) {
      // `entityId` here is a TYPE object rather than an element; `willBeEmitted`
      // resolves either the same way (#2030).
      if (!willBeEmitted(entityId)) continue;
      const resolved = resolveTypeOwnedPsetIds(
        typeOwnedPsetIdsByEntity.get(entityId) ?? [],
        typeOwnedPsetNames,
        generatedTypeOwnedPsetIds.get(entityId) ?? new Map(),
        (psetId) => this.getPropertySetName(psetId),
      );
      if (effective.isOverlayCreated(entityId)) {
        // No source line to rewrite: the new-entities pass writes this record
        // from its authored payload, so the list rides in as a slot override.
        overlayTypeOwnedPsets.set(
          entityId,
          resolved.length > 0 ? resolved.map((id) => `#${id}`) : null,
        );
        continue;
      }
      const rewritten = this.replaceEntityAttribute(
        entityId,
        HAS_PROPERTY_SETS_SLOT,
        hasPropertySetsToken(resolved),
      );
      if (rewritten) {
        rewrittenEntityLines.set(entityId, rewritten);
      }
    }

    // Generate new quantity entities for mutations
    for (const { entityId, qsets } of newQuantitySets) {
      if (!willBeEmitted(entityId)) continue;
      const newEntities = this.generateQuantitySetEntities(entityId, qsets, willBeEmitted, options.guidRandom);
      entities.push(...newEntities.lines);
      newEntityCount += newEntities.count;
    }

    for (const rewrittenLine of rewrittenEntityLines.values()) {
      entities.push(rewrittenLine);
    }

    // Add new georeferencing entities (IfcProjectedCRS, IfcMapConversion)
    for (const line of newGeorefLines) {
      entities.push(line);
    }

    // Add overlay-created entities (store.addEntity / mutationView.createEntity).
    // Apply the same filters as the source-iteration pass so newly-created
    // beams/slabs don't smuggle their geometry helpers (IfcCartesianPoint,
    // IfcExtrudedAreaSolid, etc.) past `includeGeometry:false` /
    // `exportPropertiesOnly()` modes.
    if (
      this.mutationView
      && (options.applyMutations !== false)
      && typeof this.mutationView.getNewEntities === 'function'
    ) {
      const getTypeMut = typeof this.mutationView.getEntityTypeMutation === 'function'
        ? this.mutationView.getEntityTypeMutation.bind(this.mutationView)
        : null;
      for (const entity of this.mutationView.getNewEntities()) {
        // A retyped overlay entity keeps its AUTHORED type on `entity.type`
        // (the overlay typeMutation is the source of truth for the effective
        // class). Resolve the effective class, then re-lay-out the authored
        // attributes from the authored layout up to it.
        const typeMut = getTypeMut ? getTypeMut(entity.expressId) : null;
        const effectiveType = typeMut?.newType ?? entity.type;
        // STEP requires UPPERCASE entity type tokens; the upper-case happens
        // here at the file-format boundary.
        const upperType = effectiveType.toUpperCase();
        if (options.includeGeometry === false && this.isGeometryEntity(upperType)) {
          continue;
        }
        if (allowedEntityIds !== null && !allowedEntityIds.has(entity.expressId)) {
          continue;
        }
        // Re-lay-out by name against the effective class (identity for
        // compatible layouts). Runs whenever a retype intent exists — even a
        // same-class retype, which carries a PredefinedType override
        // (e.g. setEntityType(id, 'IfcColumn', 'PILASTER')).
        let argsText: string;
        if (typeMut) {
          // Serialize against the AUTHORED layout (`entity.type`); retypeArgTokens
          // then re-lays the tokens out by name up to the effective class.
          const srcTokens = entity.attributes.map(
            (value, i) => serializeAttributeSlot(entity.type, i, value, sourceSchema),
          );
          const { tokens } = retypeArgTokens(
            srcTokens,
            entity.type,
            effectiveType,
            typeMut.predefinedType ?? null,
            sourceSchema,
          );
          argsText = tokens.join(',');
        } else {
          argsText = serializeEntityArgs(entity.type, entity.attributes, sourceSchema);
        }
        // Edits made AFTER the create live in the overlay, never in the
        // authored payload (#2006). The source-iteration pass applies them to
        // source records via applyAttributeMutations / applyPositionalMutations;
        // an overlay-created entity has no source record, so without this it was
        // written from its creation payload alone and every later
        // `setAttribute` / `setPositionalAttribute` was silently dropped on
        // save — data loss with no error and no warning.
        //
        // Order mirrors the source pass: retype (above) -> named attributes ->
        // positional overrides, all resolved against the EFFECTIVE class.
        const attributeOverrides = modifiedAttributes.get(entity.expressId) ?? null;
        const queuedPositional = typeof this.mutationView.getPositionalMutationsForEntity === 'function'
          ? this.mutationView.getPositionalMutationsForEntity(entity.expressId)
          : null;
        // A created TYPE object owns its psets through HasPropertySets, and the
        // ids of the psets this export generated are only known now — so they
        // arrive as one more slot override rather than through the overlay.
        // `has`, not `??`, for the same reason `overlaySlotValue` gives: the
        // stored value is deliberately null when the resolved list is empty.
        const positionalOverrides = overlayTypeOwnedPsets.has(entity.expressId)
          ? new Map(queuedPositional).set(
              HAS_PROPERTY_SETS_SLOT,
              overlayTypeOwnedPsets.get(entity.expressId) ?? null,
            )
          : queuedPositional;
        if (
          (attributeOverrides && attributeOverrides.size > 0)
          || (positionalOverrides && positionalOverrides.size > 0)
        ) {
          argsText = this.applyOverlayEntityOverrides(
            argsText,
            upperType,
            attributeOverrides,
            positionalOverrides,
            sourceSchema,
          );
        }
        const line = `#${entity.expressId}=${upperType}(${argsText});`;
        if (converting) {
          const converted = convertStepLine(line, sourceSchema, schema, options.guidRandom);
          if (converted !== null) {
            entities.push(converted);
            newEntityCount++;
          }
        } else {
          entities.push(line);
          newEntityCount++;
        }
      }
    }

    // Assemble final file as Uint8Array chunks to avoid V8 string length limit.
    // The header is built last so its provenance item reflects the real count.
    const header = buildHeader(newEntityCount + modifiedEntityCount);
    const content = assembleStepBytes(header, entities);

    return {
      content,
      stats: {
        entityCount: entities.length,
        newEntityCount,
        modifiedEntityCount,
        fileSize: content.byteLength,
        warnings,
      },
    };
  }

  /**
   * Async export that yields to the event loop periodically, keeping the
   * UI responsive during large exports. Calls onProgress with live stats.
   */
  async exportAsync(options: StepExportOptions): Promise<StepExportResult> {
    const onProgress = options.onProgress;

    // Report preparing phase
    const totalEntities = getCompleteEntityIndex(this.dataStore).size;
    if (onProgress) onProgress({ phase: 'preparing', percent: 0, entitiesProcessed: 0, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    // The sync export does the heavy lifting — we can't easily break it into
    // chunks without duplicating the entire method, so we report phases around it.
    if (onProgress) onProgress({ phase: 'entities', percent: 0.1, entitiesProcessed: 0, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    const result = this.export(options);

    if (onProgress) onProgress({ phase: 'assembling', percent: 0.95, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    await new Promise(r => setTimeout(r, 0));

    return result;
  }

  /**
   * Export only property/quantity changes (lightweight export)
   */
  exportPropertiesOnly(options: Omit<StepExportOptions, 'includeGeometry'>): StepExportResult {
    return this.export({
      ...options,
      includeGeometry: false,
      deltaOnly: true,
    });
  }

  /**
   * Resolve a STEP reference to an existing IfcOwnerHistory for the
   * IfcPropertySet / IfcRelDefinesByProperties / IfcElementQuantity entities we
   * generate for `hostEntityId`'s mutations. OwnerHistory is optional in IFC4 but
   * MANDATORY in IFC2X3 (IfcRoot.OwnerHistory), so emitting `$` yields an invalid
   * IFC2X3 file that strict readers (e.g. BIM Vision) reject.
   *
   * Prefer the host element's OWN owner history, then any owner history that
   * survives this export, then `$` only when none does.
   *
   * "Survives" is `willBeEmitted`, the same predicate that decides whether the
   * host itself may have psets generated for it. A reference is a reference: it
   * is no more acceptable to point an emitted `IfcPropertySet` at an owner
   * history the session deleted than at a host it deleted. This used to consult
   * only the `visibleOnly` closure, so an overlay-created OwnerHistory that was
   * later deleted still got referenced — a dangling `#N`, reached through the
   * one attribute the generators fill in for themselves.
   */
  private resolveOwnerHistoryRef(hostEntityId: number, willBeEmitted: (id: number) => boolean): string {
    const own = this.getOwnerHistoryRefOfEntity(hostEntityId);
    if (own !== null) {
      const ownId = parseInt(own.slice(1), 10);
      if (willBeEmitted(ownId)) return own;
    }
    if (this.ownerHistoryFallbackRef === undefined) {
      // Source-only: the fallback is a best-effort "some owner history the file
      // still has", and the host's OWN history above is the path that resolves
      // an overlay-created one.
      const ids = this.dataStore.entityIndex.byType.get('IFCOWNERHISTORY') ?? [];
      const surviving = ids.find((id: number) => willBeEmitted(id));
      this.ownerHistoryFallbackRef = surviving !== undefined ? `#${surviving}` : '$';
    }
    return this.ownerHistoryFallbackRef;
  }


  /**
   * The overlay's answer for one positional slot of an overlay-created entity,
   * falling back to the creation payload only when the overlay has NOTHING to
   * say about that slot.
   *
   * **Ask `Map.has`, never `??`.** `setPositionalAttribute(id, slot, null)` is
   * an explicit "clear this slot", and its value is `null`, so `??` reads the
   * overlay's answer as an absence and reinstates the authored one. That is the
   * same overlay-versus-buffer confusion this whole change is about, one
   * attribute wide: an explicit null IS the overlay's answer, and the overlay is
   * the authority. Cleared OwnerHistory came back as the authored reference, and
   * a cleared `HasPropertySets` resurrected the list the user had removed.
   */
  private overlaySlotValue(
    entityId: number,
    slot: number,
    authored: IfcAttributeValue | undefined,
  ): IfcAttributeValue | undefined {
    const overrides = this.mutationView?.getPositionalMutationsForEntity(entityId);
    if (!overrides?.has(slot)) return authored;
    const value = overrides.get(slot);
    // `Map.get` widens to `| undefined`, which `has` has already ruled out. A
    // slot explicitly set to nothing serializes as `$`, i.e. null.
    return value === undefined ? null : value;
  }

  /**
   * Read an element's own OwnerHistory reference (`#id`), or null when the
   * element omits one (`$`) or cannot be parsed. OwnerHistory is the second
   * attribute of every IfcRoot subtype, immediately after the GlobalId string.
   */
  private getOwnerHistoryRefOfEntity(entityId: number): string | null {
    const cached = this.ownerHistoryByEntity.get(entityId);
    if (cached !== undefined) return cached;
    let result: string | null = null;
    // An overlay-created host has no source line to read, but it does have an
    // authored OwnerHistory in slot 1 — reading only the buffer sent every
    // generated pset on a created entity to the file's first owner history
    // instead of the one the caller named (#2012).
    const overlay = this.mutationView?.getNewEntity(entityId);
    if (overlay) {
      const refs = authoredEntityRefs(
        this.overlaySlotValue(entityId, OWNER_HISTORY_SLOT, overlay.attributes[OWNER_HISTORY_SLOT]),
      );
      result = refs.length > 0 ? `#${refs[0]}` : null;
      this.ownerHistoryByEntity.set(entityId, result);
      return result;
    }
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (entityRef && this.dataStore.source && entityRef.byteLength > 0) {
      const entityText = safeUtf8Decode(
        this.dataStore.source,
        entityRef.byteOffset,
        entityRef.byteOffset + entityRef.byteLength
      );
      // #ID=IFCWALL('GlobalId',#owner,...): GlobalId is a quoted STEP string
      // (doubled '' escapes); OwnerHistory is the ref/`$` right after it.
      const match = entityText.match(/=\s*IFC\w+\s*\(\s*'(?:[^']|'')*'\s*,\s*#(\d+)/i);
      if (match) result = `#${match[1]}`;
    }
    this.ownerHistoryByEntity.set(entityId, result);
    return result;
  }

  /**
   * Generate STEP entities for property sets
   */
  private generatePropertySetEntities(
    entityId: number,
    psets: PropertySet[],
    willBeEmitted: (id: number) => boolean,
    typeOwnedPsetNames?: Set<string>,
    random?: RandomSource
  ): { lines: string[]; count: number; generatedTypeOwnedPsetIds: Map<string, number> } {
    const lines: string[] = [];
    let count = 0;
    const generatedTypeOwnedPsetIds = new Map<string, number>();

    for (const pset of psets) {
      const propertyIds: number[] = [];

      // Create IfcPropertySingleValue for each property
      for (const prop of pset.properties) {
        const propId = this.nextExpressId++;
        count++;

        const valueStr = serializePropertyValue(prop.value, prop.type);
        const unitId = prop.unit ? this.findUnitId(prop.unit) : null;
        const unitStr = unitId !== null ? ref(unitId) : null;

        // #ID=IFCPROPERTYSINGLEVALUE('Name',$,Value,Unit);
        const line = `#${propId}=IFCPROPERTYSINGLEVALUE('${escapeStepString(prop.name)}',$,${valueStr},${unitStr ? serializeValue(unitStr) : '$'});`;
        lines.push(line);
        propertyIds.push(propId);
      }

      // Create IfcPropertySet
      const psetId = this.nextExpressId++;
      count++;

      const propRefs = propertyIds.map(id => `#${id}`).join(',');
      const globalId = this.generateGlobalId(random);

      // #ID=IFCPROPERTYSET('GlobalId',#ownerHistory,'Name',$,(#props));
      const psetLine = `#${psetId}=IFCPROPERTYSET('${globalId}',${this.resolveOwnerHistoryRef(entityId, willBeEmitted)},'${escapeStepString(pset.name)}',$,(${propRefs}));`;
      lines.push(psetLine);

      if (typeOwnedPsetNames?.has(pset.name)) {
        generatedTypeOwnedPsetIds.set(pset.name, psetId);
      } else {
        // Create IfcRelDefinesByProperties to link pset to entity
        const relId = this.nextExpressId++;
        count++;

        const relGlobalId = this.generateGlobalId(random);
        // #ID=IFCRELDEFINESBYPROPERTIES('GlobalId',#ownerHistory,$,$,(#entity),#pset);
        const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${this.resolveOwnerHistoryRef(entityId, willBeEmitted)},$,$,(#${entityId}),#${psetId});`;
        lines.push(relLine);
      }
    }

    return { lines, count, generatedTypeOwnedPsetIds };
  }

  /**
   * Generate STEP entities for quantity sets (IfcElementQuantity)
   */
  private generateQuantitySetEntities(
    entityId: number,
    qsets: QuantitySet[],
    willBeEmitted: (id: number) => boolean,
    random?: RandomSource
  ): { lines: string[]; count: number } {
    const lines: string[] = [];
    let count = 0;

    for (const qset of qsets) {
      const quantityIds: number[] = [];

      for (const q of qset.quantities) {
        const qId = this.nextExpressId++;
        count++;

        const ifcType = quantityTypeToIfcType(q.type);
        // #ID=IFCQUANTITYLENGTH('Name',$,$,Value,$);
        const val = toStepReal(q.value);
        const line = `#${qId}=${ifcType}('${escapeStepString(q.name)}',$,$,${val},$);`;
        lines.push(line);
        quantityIds.push(qId);
      }

      // Create IfcElementQuantity
      const qsetId = this.nextExpressId++;
      count++;

      const quantRefs = quantityIds.map(id => `#${id}`).join(',');
      const globalId = this.generateGlobalId(random);

      // #ID=IFCELEMENTQUANTITY('GlobalId',#ownerHistory,'Name',$,$,(#quants));
      const qsetLine = `#${qsetId}=IFCELEMENTQUANTITY('${globalId}',${this.resolveOwnerHistoryRef(entityId, willBeEmitted)},'${escapeStepString(qset.name)}',$,$,(${quantRefs}));`;
      lines.push(qsetLine);

      // Create IfcRelDefinesByProperties to link qset to entity
      const relId = this.nextExpressId++;
      count++;

      const relGlobalId = this.generateGlobalId(random);
      const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${this.resolveOwnerHistoryRef(entityId, willBeEmitted)},$,$,(#${entityId}),#${qsetId});`;
      lines.push(relLine);
    }

    return { lines, count };
  }

  /**
   * Rewrite root IFC attributes directly on the original STEP entity line.
   */
  private applyAttributeMutations(
    entityText: string,
    entityType: string,
    attributeMutations: Map<string, string>,
  ): string {
    const openParen = entityText.indexOf('(');
    const closeParen = entityText.lastIndexOf(');');
    if (openParen < 0 || closeParen < openParen) {
      return entityText;
    }

    // Cross-schema, not the IFC4 pin: an IFC4X3-only class (IfcCourse, IfcRoad,
    // IfcBridge, …) resolves no slots under the pin, so every named edit on one
    // was silently discarded here too. Identical for the 755 pinned classes
    // that declare attributes — `attribute-slot-types.test.ts` measures that —
    // so no IFC4 export changes; this only stops dropping edits it used to drop.
    const attrNames = getAttributeNamesAcrossSchemas(entityType);
    if (attrNames.length === 0) {
      return entityText;
    }

    const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
    // A source line NEVER pads (unlike the overlay-created path): a short
    // argument list here means the file speaks a different schema, and growing
    // a record we did not author would corrupt it.
    let changed = false;

    for (const [attrName, value] of attributeMutations) {
      const index = attrNames.indexOf(attrName);
      if (index < 0 || index >= args.length) continue;
      // The source path shares every `$`-slot hole with the overlay-created
      // path, because a source record has plenty of `$` slots of its own. Both
      // go through the one helper below.
      args[index] = this.serializeNamedAttribute(entityType, index, value, args[index]);
      changed = true;
    }

    if (!changed) {
      return entityText;
    }

    return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
  }

  /**
   * Serialize one NAMED attribute override into its slot — the single point
   * both the source-buffer rewrite and the overlay-created rewrite go through.
   *
   * `serializeAttributeValue` decides the STEP form by reading the token being
   * replaced, which is sound only while that token carries type information. A
   * `$` slot carries none, and both paths have plenty: a source record's
   * optional attributes are `$`, and overlay-created records pad missing slots
   * with `$`. So the declared type decides first, and inference is the fallback
   * for slots the schema does not classify (references, SELECTs, numerics),
   * where reading the old token is exactly the right heuristic.
   */
  private serializeNamedAttribute(
    entityType: string,
    index: number,
    value: string,
    currentToken: string,
  ): string {
    if (getEnumTypedSlots(entityType).has(index)) return serializeEnumToken(value);
    if (getStringTypedSlots(entityType).has(index)) return serializeStringSlot(value);
    return serializeAttributeValue(value, currentToken);
  }

  /**
   * Apply overlay attribute + positional overrides to an OVERLAY-CREATED
   * entity's argument list (#2006).
   *
   * Distinct from {@link applyAttributeMutations} / {@link applyPositionalMutations},
   * which rewrite a line read out of the source buffer. Here the whole line is
   * ours: it was serialized moments ago from the creation payload, so the
   * argument list is the authoring payload's, not the file's. That difference
   * is why this PADS — `entity_create` takes whatever positional list the
   * caller passes, so a wall authored with three arguments still has a real
   * `Tag` slot at index 7, and dropping the edit because the payload was short
   * would be the very data loss this fixes. The source-buffer path must not
   * pad: there a short line means a different schema, and growing a record we
   * did not author would corrupt it.
   *
   * Named and positional overrides resolve to a slot index up front and share
   * ONE padding rule. Two padding rules on one record is how the next bug
   * starts, and the argument for padding — the class is fixed at creation time,
   * so a short payload is partial authoring — never depended on which of the
   * two APIs queued the edit.
   */
  private applyOverlayEntityOverrides(
    argsText: string,
    entityType: string,
    attributeOverrides: Map<string, string> | null,
    positionalOverrides: Map<number, IfcAttributeValue> | null,
    schemaVersion: IfcSchemaVersion,
  ): string {
    const args = argsText.length > 0 ? splitTopLevelArgs(argsText) : [];
    const attrNames = getAttributeNamesAcrossSchemas(entityType);

    const named: Array<[number, string]> = [];
    for (const [attrName, value] of attributeOverrides ?? []) {
      const index = attrNames.indexOf(attrName);
      if (index >= 0) named.push([index, value]);
    }

    // Grow to the class's FULL declared arity as soon as any override names a
    // declared slot the creation payload never reached. Growing only as far as
    // the edited slot would emit eight arguments for an IfcWall that declares
    // nine: this parser tolerates the truncated record, a schema-validating
    // consumer rejects the file.
    //
    // An index PAST the declared layout is not a slot at all, so it cannot
    // justify growing the record and stays dropped — as does any override on a
    // class neither schema source knows, where there is no arity to grow to.
    let needsPad = named.some(([index]) => index >= args.length);
    if (!needsPad && positionalOverrides) {
      for (const [index] of positionalOverrides) {
        if (index >= args.length && index < attrNames.length) {
          needsPad = true;
          break;
        }
      }
    }
    if (needsPad) {
      while (args.length < attrNames.length) args.push('$');
    }

    // Every `named` index is < attrNames.length by construction, and padding
    // has taken args.length to at least that, so each one lands.
    for (const [index, value] of named) {
      args[index] = this.serializeNamedAttribute(entityType, index, value, args[index]);
    }

    if (positionalOverrides && positionalOverrides.size > 0) {
      const realSlots = getRealTypedSlots(entityType, schemaVersion);
      for (const [index, value] of positionalOverrides) {
        if (index < 0 || index >= args.length) continue;
        args[index] = this.serializePositionalOverride(
          entityType,
          index,
          value,
          args[index],
          realSlots,
          schemaVersion,
        );
      }
    }

    return args.join(',');
  }

  /**
   * Apply positional STEP argument overrides to an entity line.
   * Used for non-IfcRoot edits (e.g. profile dimensions) where attributes
   * have no symbolic names. Indexes that fall outside the existing arg list
   * are silently ignored.
   */
  private applyPositionalMutations(
    entityText: string,
    positionals: Map<number, IfcAttributeValue>,
    entityType: string,
    schemaVersion: IfcSchemaVersion,
  ): string {
    const openParen = entityText.indexOf('(');
    const closeParen = entityText.lastIndexOf(');');
    if (openParen < 0 || closeParen < openParen) return entityText;

    const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
    const realSlots = getRealTypedSlots(entityType, schemaVersion);
    let changed = false;
    for (const [index, value] of positionals) {
      if (index < 0 || index >= args.length) continue;
      args[index] = this.serializePositionalOverride(entityType, index, value, args[index], realSlots, schemaVersion);
      changed = true;
    }
    if (!changed) return entityText;
    return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
  }

  /**
   * Serialize one positional override, composing the schema-aware passes:
   * explicit `{ real }`/`{ typed }` marker → SELECT auto-qualification
   * (`IFCBOOLEAN(.T.)`) → REAL forcing. For REAL forcing the current source
   * token is a secondary signal: replacing a value that was already a REAL
   * (`0.4`, `1.5E-7`) keeps it REAL even for entities the XSD index doesn't
   * cover, so a whole-number edit can't silently downgrade the slot.
   */
  private serializePositionalOverride(
    entityType: string,
    index: number,
    value: IfcAttributeValue,
    currentToken: string,
    realSlots: ReadonlySet<number>,
    schemaVersion: IfcSchemaVersion,
  ): string {
    if (isTypedMarker(value)) return serializeStepValue(value);
    const qualified = serializeQualifiedSelectSlot(entityType, index, value);
    if (qualified !== null) return qualified;
    const forceReal = realSlots.has(index) || tokenIsRealLiteral(currentToken);
    return serializeStepValue(value, forceReal);
  }

  private resolveMapUnitReference(unitName: string, newGeorefLines: string[]): number {
    const normalized = this.normalizeMapUnitName(unitName);
    const existing = this.findLengthUnitReference(normalized);
    if (existing !== null) {
      return existing;
    }

    if (normalized === 'METRE') {
      const unitId = this.nextExpressId++;
      newGeorefLines.push(`#${unitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
      return unitId;
    }

    if (normalized === 'FOOT' || normalized === 'US SURVEY FOOT') {
      const dimId = this.nextExpressId++;
      const siUnitId = this.nextExpressId++;
      const measureId = this.nextExpressId++;
      const convUnitId = this.nextExpressId++;
      const factor = normalized === 'US SURVEY FOOT' ? 1200 / 3937 : 0.3048;
      const name = normalized === 'US SURVEY FOOT' ? 'US SURVEY FOOT' : 'FOOT';
      newGeorefLines.push(`#${dimId}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);`);
      newGeorefLines.push(`#${siUnitId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
      newGeorefLines.push(`#${measureId}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${toStepReal(factor)}),#${siUnitId});`);
      newGeorefLines.push(`#${convUnitId}=IFCCONVERSIONBASEDUNIT(#${dimId},.LENGTHUNIT.,'${name}',#${measureId});`);
      return convUnitId;
    }

    const fallbackId = this.nextExpressId++;
    newGeorefLines.push(`#${fallbackId}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
    return fallbackId;
  }

  private normalizeMapUnitName(unitName: string): string {
    const normalized = unitName.trim().toUpperCase().replace(/\s+/g, ' ');
    if (normalized.includes('US SURVEY FOOT')) return 'US SURVEY FOOT';
    if (normalized.includes('METER') || normalized.includes('METRE')) return 'METRE';
    if (normalized.includes('FOOT') || normalized.includes('FEET')) return 'FOOT';
    return normalized;
  }

  private findLengthUnitReference(preferredUnitName: string): number | null {
    if (!this.entityExtractor) return null;

    const projectIds = this.dataStore.entityIndex.byType.get('IFCPROJECT') ?? [];
    const projectRef = projectIds[0] ? this.dataStore.entityIndex.byId.get(projectIds[0]) : undefined;
    const project = projectRef ? this.entityExtractor.extractEntity(projectRef) : null;
    const unitAssignmentId = project?.attributes?.[8];
    if (typeof unitAssignmentId !== 'number') return null;

    const unitAssignmentRef = this.dataStore.entityIndex.byId.get(unitAssignmentId);
    const unitAssignment = unitAssignmentRef ? this.entityExtractor.extractEntity(unitAssignmentRef) : null;
    const units = unitAssignment?.attributes?.[0];
    if (!Array.isArray(units)) return null;

    for (const unitId of units) {
      if (typeof unitId !== 'number') continue;
      const unitRef = this.dataStore.entityIndex.byId.get(unitId);
      const unit = unitRef ? this.entityExtractor.extractEntity(unitRef) : null;
      if (!unit) continue;

      const typeName = unit.type.toUpperCase();
      const attrs = unit.attributes ?? [];
      const unitType = typeof attrs[1] === 'string' ? attrs[1].replace(/\./g, '').toUpperCase() : '';
      if (unitType !== 'LENGTHUNIT') continue;

      if (typeName === 'IFCSIUNIT') {
        const prefix = typeof attrs[2] === 'string' ? attrs[2].replace(/\./g, '').toUpperCase() : '';
        const name = typeof attrs[3] === 'string' ? attrs[3].replace(/\./g, '').toUpperCase() : '';
        const combined = prefix ? `${prefix}${name}` : name;
        if (preferredUnitName === 'METRE' && (combined === 'METRE' || combined === 'METER')) {
          return unitId;
        }
      }

      if (typeName === 'IFCCONVERSIONBASEDUNIT') {
        const name = typeof attrs[2] === 'string' ? this.normalizeMapUnitName(attrs[2]) : '';
        if (name === preferredUnitName) {
          return unitId;
        }
      }
    }

    return null;
  }

  /**
   * Record that a requested IfcMapConversion could not be written. Emitting it
   * anyway would leave `SourceCRS` pointing at nothing, so the refusal is the
   * correct output — but the file alone cannot express it, which is why it goes
   * back to the caller in `stats.warnings` as well as to the console (#2067).
   */
  private reportMapConversionRefused(warnings: string[]): void {
    warnings.push(MAP_CONVERSION_WITHOUT_CONTEXT_WARNING);
    console.warn(`[StepExporter] ${MAP_CONVERSION_WITHOUT_CONTEXT_WARNING}`);
  }

  private findPreferredGeometricRepresentationContextId(): number | null {
    if (!this.entityExtractor) return null;

    const contextIds = this.dataStore.entityIndex.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [];
    let first3dContext: number | null = null;

    for (const contextId of contextIds) {
      const contextRef = this.dataStore.entityIndex.byId.get(contextId);
      const context = contextRef ? this.entityExtractor.extractEntity(contextRef) : null;
      if (!context) continue;

      const attrs = context.attributes ?? [];
      const contextType = typeof attrs[1] === 'string' ? attrs[1].trim().toUpperCase() : '';
      const dimension = typeof attrs[2] === 'number' ? attrs[2] : null;

      if (dimension === 3 && first3dContext === null) {
        first3dContext = contextId;
      }

      if (contextType === 'MODEL' && dimension === 3) {
        return contextId;
      }
    }

    return first3dContext ?? contextIds[0] ?? null;
  }

  /**
   * Generate a new IFC GlobalId (22 character base64). `random` is the
   * export's optional seeded source (`StepExportOptions.guidRandom`);
   * undefined keeps the default random path.
   */
  private generateGlobalId(random?: RandomSource): string {
    return generateIfcGuid(random);
  }

  /**
   * Find the maximum EXPRESS ID in the data store
   */
  private findMaxExpressId(): number {
    // Span deferred property atoms too, so newly allocated ids can't collide
    // with a deferred entity sitting at a higher express id than anything in byId.
    return getMaxExpressId(getCompleteEntityIndex(this.dataStore));
  }

  /**
   * Find a unit entity ID by name (simplified - returns null for now)
   */
  private findUnitId(unitName: string): number | null {
    return this.findLengthUnitReference(this.normalizeMapUnitName(unitName));
  }

  /**
   * Check if an entity type is a geometry-related type
   */
  private isGeometryEntity(type: string): boolean {
    const geometryTypes = new Set([
      'IFCCARTESIANPOINT',
      'IFCDIRECTION',
      'IFCAXIS2PLACEMENT2D',
      'IFCAXIS2PLACEMENT3D',
      'IFCLOCALPLACEMENT',
      'IFCSHAPEREPRESENTATION',
      'IFCPRODUCTDEFINITIONSHAPE',
      'IFCGEOMETRICREPRESENTATIONCONTEXT',
      'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
      'IFCEXTRUDEDAREASOLID',
      'IFCFACETEDBREP',
      'IFCPOLYLOOP',
      'IFCFACE',
      'IFCFACEOUTERBOUND',
      'IFCCLOSEDSHELL',
      'IFCRECTANGLEPROFILEDEF',
      'IFCCIRCLEPROFILEDEF',
      'IFCARBITRARYCLOSEDPROFILEDEF',
      'IFCPOLYLINE',
      'IFCTRIMMEDCURVE',
      'IFCBSPLINECURVE',
      'IFCBSPLINESURFACE',
      'IFCTRIANGULATEDFACESET',
      'IFCPOLYGONALFACE',
      'IFCINDEXEDPOLYGONALFACE',
      'IFCPOLYGONALFACESET',
      'IFCSTYLEDITEM',
      'IFCPRESENTATIONSTYLEASSIGNMENT',
      'IFCSURFACESTYLE',
      'IFCSURFACESTYLERENDERING',
      'IFCCOLOURRGB',
    ]);
    return geometryTypes.has(type);
  }

  /**
   * Build a one-shot reverse index of every IfcRelDefinesByProperties in
   * the source: for each related entity, list the rels and property/quantity
   * sets that reference it. Used by the export pre-pass so the per-entity
   * "find owning rels" step is O(K) rather than O(N) per modified entity.
   *
   * `relatedByRel` is the same walk read the other way round, so the deleted-host
   * sweep costs nothing extra.
   */
  private buildRelDefinesByPropertiesIndex(): {
    byEntity: Map<number, Array<{ relId: number; psetId: number }>>;
    relatedByRel: Map<number, number[]>;
  } {
    const byEntity = new Map<number, Array<{ relId: number; psetId: number }>>();
    const relatedByRel = new Map<number, number[]>();
    for (const [relId, relRef] of this.dataStore.entityIndex.byId) {
      if (relRef.type.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') continue;
      const psetId = this.getRelatedPropertySet(relId);
      if (!psetId) continue;
      const related = this.getRelatedEntities(relId);
      relatedByRel.set(relId, related);
      for (const entityId of related) {
        let bucket = byEntity.get(entityId);
        if (!bucket) {
          bucket = [];
          byEntity.set(entityId, bucket);
        }
        bucket.push({ relId, psetId });
      }
    }
    return { byEntity, relatedByRel };
  }

  /**
   * Get entity IDs related by IfcRelDefinesByProperties (the related objects)
   */
  private getRelatedEntities(relId: number): number[] {
    const entityRef = this.dataStore.entityIndex.byId.get(relId);
    if (!entityRef || !this.dataStore.source) return [];

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    // Parse IfcRelDefinesByProperties: #ID=IFCRELDEFINESBYPROPERTIES('guid',$,$,$,(#objects),#pset);
    // The 5th argument (index 4) is the list of related objects
    const match = entityText.match(/\(([^)]+)\)\s*,\s*#(\d+)\s*\)\s*;/);
    if (!match) return [];

    const objectsList = match[1];
    const refs: number[] = [];
    const refMatches = objectsList.matchAll(/#(\d+)/g);
    for (const m of refMatches) {
      refs.push(parseInt(m[1], 10));
    }
    return refs;
  }

  /**
   * Get the property set ID from IfcRelDefinesByProperties
   */
  private getRelatedPropertySet(relId: number): number | null {
    const entityRef = this.dataStore.entityIndex.byId.get(relId);
    if (!entityRef || !this.dataStore.source) return null;

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    // Last #ID before the closing );
    const match = entityText.match(/,\s*#(\d+)\s*\)\s*;$/);
    if (!match) return null;
    return parseInt(match[1], 10);
  }

  /**
   * Get the name of a property set by parsing the entity
   */
  private getPropertySetName(psetId: number): string | null {
    const entityRef = this.dataStore.entityIndex.byId.get(psetId);
    if (!entityRef || !this.dataStore.source) return null;

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    // Parse: IFCPROPERTYSET('guid',$,'Name',$,...) - Name is 3rd argument
    const match = entityText.match(/IFCPROPERTYSET\s*\([^,]*,[^,]*,'([^']*)'/i);
    if (!match) return null;
    return match[1];
  }

  /**
   * Get the name of an element quantity set by parsing the entity
   */
  private getElementQuantityName(entityId: number): string | null {
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (!entityRef || !this.dataStore.source) return null;

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    // Parse: IFCELEMENTQUANTITY('guid',$,'Name',...) - Name is 3rd argument
    const match = entityText.match(/IFCELEMENTQUANTITY\s*\([^,]*,[^,]*,'([^']*)'/i);
    if (!match) return null;
    return match[1];
  }

  /**
   * Get IDs of properties in a property set
   */
  /**
   * Un-skip property/quantity atoms that a surviving (non-skipped, and — under
   * visible-only export — still-included) IfcPropertySet / IfcElementQuantity
   * still references.
   *
   * When a property is edited, the modified pset is replaced and its member atoms
   * are added to `skipIds` wholesale. Because exporters deduplicate shared
   * Pset_*Common atoms (e.g. a single IsExternal / IsLoadBearing value referenced
   * by many psets), that wholesale skip can drop an atom another pset still needs.
   * This pass restores any such atom: the edited pset still emits its replacement
   * with the new value, while the shared atom stays for the psets that keep their
   * original value.
   */
  private retainSharedAtoms(skipIds: Set<number>, allowedEntityIds: Set<number> | null): void {
    if (skipIds.size === 0) return;
    const byType = this.dataStore.entityIndex.byType;
    const containerIds = [
      ...(byType.get('IFCPROPERTYSET') ?? []),
      ...(byType.get('IFCELEMENTQUANTITY') ?? []),
    ];
    for (const containerId of containerIds) {
      // Skipped containers are being dropped/replaced — their atoms may go.
      if (skipIds.has(containerId)) continue;
      // Under visible-only export a container outside the closure is not emitted,
      // so it cannot keep an atom alive.
      if (allowedEntityIds !== null && !allowedEntityIds.has(containerId)) continue;
      for (const atomId of this.getPropertyIdsInSet(containerId)) {
        skipIds.delete(atomId);
      }
    }
  }

  private getPropertyIdsInSet(psetId: number): number[] {
    const entityRef = this.dataStore.entityIndex.byId.get(psetId);
    if (!entityRef || !this.dataStore.source) return [];

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    // Parse: IFCPROPERTYSET(...,(#prop1,#prop2,...)); - Last argument is properties list
    const match = entityText.match(/\(\s*(#[^)]+)\s*\)\s*\)\s*;$/);
    if (!match) return [];

    const propsList = match[1];
    const ids: number[] = [];
    const refMatches = propsList.matchAll(/#(\d+)/g);
    for (const m of refMatches) {
      ids.push(parseInt(m[1], 10));
    }
    return ids;
  }

  /**
   * The full HasPropertySets id list of a type object, from whichever authority
   * owns the record.
   *
   * Slot 5 is `HasPropertySets` on every `IfcTypeObject` subtype. For a source
   * record the list is parsed out of the file; for an overlay-created type it is
   * read off the authored payload, where a reference is the documented `'#42'`
   * string form. Reading only the source made every pset on a created
   * `IfcWallType` look unowned, which is how it ended up on an occurrence
   * relation instead (#2012).
   */
  private getTypeOwnedHasPropertySetIds(entityId: number, effective: EffectiveEntityIndex): number[] {
    if (effective.isOverlayCreated(entityId)) {
      const authored = this.mutationView?.getNewEntity(entityId)?.attributes?.[HAS_PROPERTY_SETS_SLOT];
      return authoredEntityRefs(this.overlaySlotValue(entityId, HAS_PROPERTY_SETS_SLOT, authored));
    }
    if (!this.entityExtractor) return [];
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (!entityRef) return [];

    const entity = this.entityExtractor.extractEntity(entityRef);
    const hasPropertySets = entity?.attributes?.[HAS_PROPERTY_SETS_SLOT];
    if (!Array.isArray(hasPropertySets)) return [];

    return hasPropertySets.filter((value): value is number => typeof value === 'number');
  }

  /**
   * Replace a single top-level STEP attribute in an entity line.
   */
  private replaceEntityAttribute(entityId: number, attrIndex: number, replacement: string): string | null {
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (!entityRef || !this.dataStore.source) return null;

    const entityText = safeUtf8Decode(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );

    const match = entityText.match(/^(#\d+\s*=\s*\w+\()([\s\S]*)(\)\s*;)\s*$/);
    if (!match) return null;

    const [, prefix, attrsText, suffix] = match;
    const attrs = splitTopLevelStepArguments(attrsText);
    if (attrIndex >= attrs.length) return null;

    attrs[attrIndex] = replacement;
    return `${prefix}${attrs.join(',')}${suffix}`;
  }

}

/**
 * Quick export function for simple use cases.
 * Returns content as a string (may fail for very large files due to V8 string limit).
 * For large files, use StepExporter directly and work with the Uint8Array content.
 */
export function exportToStep(
  dataStore: IfcDataStore,
  options?: Partial<StepExportOptions>
): string {
  const exporter = new StepExporter(dataStore);
  const result = exporter.export({
    schema: 'IFC4',
    ...options,
  });
  return new TextDecoder().decode(result.content);
}

