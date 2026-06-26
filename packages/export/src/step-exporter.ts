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
  getAttributeNames,
  serializeValue,
  ref,
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import { safeUtf8Decode } from '@ifc-lite/data';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { retypeStepLine, retypeArgTokens } from './retype.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
import {
  escapeStepString,
  toStepReal,
  quantityTypeToIfcType,
  serializePropertyValue,
  serializeAttributeValue,
  serializeStepArgs,
  serializeStepValue,
  splitTopLevelArgs,
  splitTopLevelStepArguments,
  assembleStepBytes,
} from './step-serialization.js';

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
  };
}

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
      });
    };

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

    // Track property set IDs and relationship IDs to skip
    const skipPropertySetIds = new Set<number>();
    const skipRelationshipIds = new Set<number>();

    // Process mutations if we have a mutation view
    if (this.mutationView && (options.applyMutations !== false)) {
      const mutations = this.mutationView.getMutations();

      // Group mutations by entity, separating property vs quantity mutations
      const entityPropMutations = new Map<number, Set<string>>();
      const entityQuantMutations = new Map<number, Set<string>>();
      for (const mutation of mutations) {
        if (mutation.type === 'UPDATE_ATTRIBUTE' && mutation.attributeName) {
          modifiedEntities.add(mutation.entityId);
          if (!modifiedAttributes.has(mutation.entityId)) {
            modifiedAttributes.set(mutation.entityId, new Map());
          }
          modifiedAttributes.get(mutation.entityId)!.set(
            mutation.attributeName,
            mutation.newValue == null ? '' : String(mutation.newValue),
          );
          continue;
        }

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
      const relDefinesByEntity = this.buildRelDefinesByPropertiesIndex();

      // Collect modified property sets and find original psets to skip
      for (const [entityId, psetNames] of entityPropMutations) {
        modifiedEntities.add(entityId);
        modifiedPsets.set(entityId, psetNames);
        modifiedEntityCount++;

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

        if (this.isTypeEntity(entityId)) {
          const typeOwnedPsetIds = this.getTypeOwnedHasPropertySetIds(entityId);
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
        modifiedEntities.add(entityId);
        if (!modifiedPsets.has(entityId)) modifiedEntityCount++;

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
        if (!entityPropMutations.has(entityId) && !entityQuantMutations.has(entityId)) {
          modifiedEntityCount++;
        }
      }
    }

    // Process georeferencing mutations (only when applyMutations is enabled)
    const newGeorefLines: string[] = [];
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
          console.warn('[StepExporter] Cannot create IfcMapConversion: no IfcGeometricRepresentationContext found in source file');
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
          console.warn('[StepExporter] Cannot create IfcMapConversion: no IfcGeometricRepresentationContext found in source file');
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
        },
      };
    }

    // Complete view over byId + any deferred property atoms. Walking byId alone
    // drops deferred atoms while keeping the IfcPropertySet/IfcElementQuantity
    // references to them, producing dangling #-refs in the output.
    const completeIndex = getCompleteEntityIndex(this.dataStore);

    // Build visible-only closure if requested
    let allowedEntityIds: Set<number> | null = null;
    if (options.visibleOnly && this.dataStore.source) {
      const { roots, hiddenProductIds } = getVisibleEntityIds(
        this.dataStore,
        options.hiddenEntityIds ?? new Set(),
        options.isolatedEntityIds ?? null,
      );
      allowedEntityIds = collectReferencedEntityIds(
        roots,
        this.dataStore.source,
        completeIndex,
        hiddenProductIds,
      );
      // Second pass: collect IFCSTYLEDITEM entities that reference included
      // geometry. Styled items reference geometry items but nothing references
      // them back, so the forward closure misses them.
      collectStyleEntities(
        allowedEntityIds,
        this.dataStore.source,
        { byId: completeIndex, byType: this.dataStore.entityIndex.byType },
      );
    }

    // A modified pset is replaced wholesale, which skips ALL of its member atoms.
    // But IFC exporters deduplicate identical Pset_*Common atoms (e.g. one
    // IsExternal IfcPropertySingleValue shared by dozens of psets), so skipping a
    // shared atom would orphan every OTHER pset that still references it, leaving
    // dangling refs and an invalid file. Keep any atom a surviving container needs.
    this.retainSharedAtoms(skipPropertySetIds, allowedEntityIds);

    // Export original entities from source buffer, SKIPPING modified property sets
    if (!options.deltaOnly && this.dataStore.source) {
      const source = this.dataStore.source;

      // Extract existing entities from source
      const overlayActive = !!this.mutationView && (options.applyMutations !== false);
      for (const [expressId, entityRef] of completeIndex) {
        // Skip entities deleted via the overlay (only when mutations are applied)
        if (overlayActive && typeof this.mutationView!.isDeleted === 'function' && this.mutationView!.isDeleted(expressId)) {
          continue;
        }

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
          nextEntityText = this.applyPositionalMutations(nextEntityText, positional);
          if (!modifiedEntities.has(expressId)) {
            modifiedEntities.add(expressId);
            modifiedEntityCount++;
          }
        }

        // Apply schema conversion if exporting to a different schema version
        if (converting) {
          const converted = convertStepLine(nextEntityText, sourceSchema, schema);
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
    for (const { entityId, psets } of newPropertySets) {
      const newEntities = this.generatePropertySetEntities(
        entityId,
        psets,
        allowedEntityIds,
        typeOwnedPsetNamesByEntity.get(entityId)
      );
      entities.push(...newEntities.lines);
      newEntityCount += newEntities.count;

      const typeOwnedPsetNames = typeOwnedPsetNamesByEntity.get(entityId);
      if (typeOwnedPsetNames && typeOwnedPsetNames.size > 0) {
        const rewritten = this.rewriteTypeEntityHasPropertySets(
          entityId,
          typeOwnedPsetIdsByEntity.get(entityId) ?? [],
          typeOwnedPsetNames,
          newEntities.generatedTypeOwnedPsetIds
        );
        if (rewritten) {
          rewrittenEntityLines.set(entityId, rewritten);
        }
      }
    }

    // Handle type-owned pset deletions with no replacement pset content
    for (const [entityId, typeOwnedPsetNames] of typeOwnedPsetNamesByEntity) {
      if (rewrittenEntityLines.has(entityId)) continue;
      const rewritten = this.rewriteTypeEntityHasPropertySets(
        entityId,
        typeOwnedPsetIdsByEntity.get(entityId) ?? [],
        typeOwnedPsetNames,
        new Map()
      );
      if (rewritten) {
        rewrittenEntityLines.set(entityId, rewritten);
      }
    }

    // Generate new quantity entities for mutations
    for (const { entityId, qsets } of newQuantitySets) {
      const newEntities = this.generateQuantitySetEntities(entityId, qsets, allowedEntityIds);
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
          const srcTokens = entity.attributes.map(serializeStepValue);
          const { tokens } = retypeArgTokens(
            srcTokens,
            entity.type,
            effectiveType,
            typeMut.predefinedType ?? null,
            sourceSchema,
          );
          argsText = tokens.join(',');
        } else {
          argsText = serializeStepArgs(entity.attributes);
        }
        const line = `#${entity.expressId}=${upperType}(${argsText});`;
        if (converting) {
          const converted = convertStepLine(line, sourceSchema, schema);
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
   * Prefer the host element's OWN owner history: it is the semantically correct
   * owner and — being reachable from an exported root — is guaranteed to survive a
   * `visibleOnly` closure. Fall back to any owner history still inside the export
   * (closure-aware) so we never reference one a `visibleOnly` / isolated export
   * dropped, then to `$` only when the file has none.
   */
  private resolveOwnerHistoryRef(hostEntityId: number, allowedEntityIds: Set<number> | null): string {
    const own = this.getOwnerHistoryRefOfEntity(hostEntityId);
    if (own !== null) {
      const ownId = parseInt(own.slice(1), 10);
      if (allowedEntityIds === null || allowedEntityIds.has(ownId)) return own;
    }
    if (this.ownerHistoryFallbackRef === undefined) {
      const ids = this.dataStore.entityIndex.byType.get('IFCOWNERHISTORY') ?? [];
      const surviving = allowedEntityIds === null
        ? ids[0]
        : ids.find((id: number) => allowedEntityIds.has(id));
      this.ownerHistoryFallbackRef = surviving !== undefined ? `#${surviving}` : '$';
    }
    return this.ownerHistoryFallbackRef;
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
    allowedEntityIds: Set<number> | null,
    typeOwnedPsetNames?: Set<string>
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
      const globalId = this.generateGlobalId();

      // #ID=IFCPROPERTYSET('GlobalId',#ownerHistory,'Name',$,(#props));
      const psetLine = `#${psetId}=IFCPROPERTYSET('${globalId}',${this.resolveOwnerHistoryRef(entityId, allowedEntityIds)},'${escapeStepString(pset.name)}',$,(${propRefs}));`;
      lines.push(psetLine);

      if (typeOwnedPsetNames?.has(pset.name)) {
        generatedTypeOwnedPsetIds.set(pset.name, psetId);
      } else {
        // Create IfcRelDefinesByProperties to link pset to entity
        const relId = this.nextExpressId++;
        count++;

        const relGlobalId = this.generateGlobalId();
        // #ID=IFCRELDEFINESBYPROPERTIES('GlobalId',#ownerHistory,$,$,(#entity),#pset);
        const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${this.resolveOwnerHistoryRef(entityId, allowedEntityIds)},$,$,(#${entityId}),#${psetId});`;
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
    allowedEntityIds: Set<number> | null
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
      const globalId = this.generateGlobalId();

      // #ID=IFCELEMENTQUANTITY('GlobalId',#ownerHistory,'Name',$,$,(#quants));
      const qsetLine = `#${qsetId}=IFCELEMENTQUANTITY('${globalId}',${this.resolveOwnerHistoryRef(entityId, allowedEntityIds)},'${escapeStepString(qset.name)}',$,$,(${quantRefs}));`;
      lines.push(qsetLine);

      // Create IfcRelDefinesByProperties to link qset to entity
      const relId = this.nextExpressId++;
      count++;

      const relGlobalId = this.generateGlobalId();
      const relLine = `#${relId}=IFCRELDEFINESBYPROPERTIES('${relGlobalId}',${this.resolveOwnerHistoryRef(entityId, allowedEntityIds)},$,$,(#${entityId}),#${qsetId});`;
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

    const attrNames = getAttributeNames(entityType);
    if (attrNames.length === 0) {
      return entityText;
    }

    const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
    let changed = false;

    for (const [attrName, value] of attributeMutations) {
      const index = attrNames.indexOf(attrName);
      if (index < 0 || index >= args.length) continue;
      args[index] = serializeAttributeValue(value, args[index]);
      changed = true;
    }

    if (!changed) {
      return entityText;
    }

    return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
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
  ): string {
    const openParen = entityText.indexOf('(');
    const closeParen = entityText.lastIndexOf(');');
    if (openParen < 0 || closeParen < openParen) return entityText;

    const args = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
    let changed = false;
    for (const [index, value] of positionals) {
      if (index < 0 || index >= args.length) continue;
      args[index] = serializeStepValue(value);
      changed = true;
    }
    if (!changed) return entityText;
    return `${entityText.slice(0, openParen + 1)}${args.join(',')}${entityText.slice(closeParen)}`;
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
   * Generate a new IFC GlobalId (22 character base64)
   */
  private generateGlobalId(): string {
    return generateIfcGuid();
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
   */
  private buildRelDefinesByPropertiesIndex(): Map<number, Array<{ relId: number; psetId: number }>> {
    const out = new Map<number, Array<{ relId: number; psetId: number }>>();
    for (const [relId, relRef] of this.dataStore.entityIndex.byId) {
      if (relRef.type.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') continue;
      const psetId = this.getRelatedPropertySet(relId);
      if (!psetId) continue;
      for (const entityId of this.getRelatedEntities(relId)) {
        let bucket = out.get(entityId);
        if (!bucket) {
          bucket = [];
          out.set(entityId, bucket);
        }
        bucket.push({ relId, psetId });
      }
    }
    return out;
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
   * Check whether an entity is an IFC type object (e.g. IfcWallType).
   */
  private isTypeEntity(entityId: number): boolean {
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    return entityRef?.type.toUpperCase().endsWith('TYPE') ?? false;
  }

  /**
   * Get the full HasPropertySets ID list from a type entity.
   * This preserves both property and quantity definitions already assigned there.
   */
  private getTypeOwnedHasPropertySetIds(entityId: number): number[] {
    if (!this.entityExtractor) return [];
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (!entityRef) return [];

    const entity = this.entityExtractor.extractEntity(entityRef);
    const hasPropertySets = entity?.attributes?.[5];
    if (!Array.isArray(hasPropertySets)) return [];

    return hasPropertySets.filter((value): value is number => typeof value === 'number');
  }

  /**
   * Rewrite a type entity so its HasPropertySets attribute points to replacement psets.
   */
  private rewriteTypeEntityHasPropertySets(
    entityId: number,
    originalPsetIds: number[],
    affectedPsetNames: Set<string>,
    replacementPsetIds: Map<string, number>
  ): string | null {
    const rewrittenIds: number[] = [];
    const usedReplacementNames = new Set<string>();

    for (const psetId of originalPsetIds) {
      const psetName = this.getPropertySetName(psetId);
      if (psetName && affectedPsetNames.has(psetName)) {
        const replacementId = replacementPsetIds.get(psetName);
        if (replacementId !== undefined) {
          rewrittenIds.push(replacementId);
          usedReplacementNames.add(psetName);
        }
        continue;
      }
      rewrittenIds.push(psetId);
    }

    for (const [psetName, psetId] of replacementPsetIds) {
      if (!usedReplacementNames.has(psetName)) {
        rewrittenIds.push(psetId);
      }
    }

    const attrValue = rewrittenIds.length > 0
      ? `(${rewrittenIds.map(id => `#${id}`).join(',')})`
      : '$';

    return this.replaceEntityAttribute(entityId, 5, attrValue);
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

