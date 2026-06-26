/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merged IFC STEP exporter
 *
 * Combines multiple IFC models into a single STEP file, similar to
 * IfcOpenShell's MergeProjects recipe. Handles ID remapping, spatial
 * structure unification, and infrastructure deduplication.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { generateHeader, deterministicGlobalId } from '@ifc-lite/parser';
import { decodeIfcString } from '@ifc-lite/encoding';
import { safeUtf8Decode } from '@ifc-lite/data';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { assembleStepBytes } from './step-serialization.js';
import { getCompleteEntityIndex, getMaxExpressId, type CompleteEntityIndex, type ExportEntityRef } from './entity-iteration.js';

/** Entity types forming shared infrastructure (deduplicated across models). */
const SHARED_INFRASTRUCTURE_TYPES = new Set([
  'IFCUNITASSIGNMENT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
]);

/**
 * An IfcGloballyUniqueId is exactly 22 characters of the buildingSMART base64
 * alphabet. We use this to recognise a rooted entity (IfcRoot subtype) by its
 * first attribute. Geometry/list entities never carry a string there, but some
 * non-rooted RESOURCE entities lead with a Name/Identifier string that can
 * legitimately be 22 charset chars (e.g. a coded property key). Those are
 * excluded by type ({@link NON_ROOTED_STRING_TYPES}) so their Name is never
 * mistaken for a GlobalId — otherwise the GlobalId reconciliation could drop or
 * rename them.
 */
const GLOBAL_ID_RE = /^[0-9A-Za-z_$]{22}$/;

/**
 * Non-IfcRoot entity types whose first attribute is (or can be) a quoted
 * Name/Identifier string. They must NOT be treated as rooted by GlobalId, even
 * when that string happens to be 22 charset characters. (IfcRoot property
 * containers like IFCPROPERTYSET / IFCELEMENTQUANTITY are deliberately absent —
 * they ARE rooted and carry a real GlobalId at attribute 0.)
 *
 * This is a best-effort denylist, not an exhaustive IfcRoot classifier — the
 * merge works off raw STEP text and has no schema table. It covers the resource
 * families that realistically appear in federated models; an unlisted
 * string-leading resource type is only ever a problem if two models share an
 * identical 22-char charset Name for it AND it collides, which is negligible. A
 * miss in the other direction (treating a real root as non-rooted) is safe — it
 * just skips one GlobalId reconciliation.
 */
const NON_ROOTED_STRING_TYPES = new Set([
  // IfcSimpleProperty / IfcComplexProperty (IfcPropertyAbstraction — not rooted)
  'IFCPROPERTYSINGLEVALUE', 'IFCPROPERTYENUMERATEDVALUE', 'IFCPROPERTYLISTVALUE',
  'IFCPROPERTYBOUNDEDVALUE', 'IFCPROPERTYTABLEVALUE', 'IFCPROPERTYREFERENCEVALUE',
  'IFCCOMPLEXPROPERTY',
  // IfcPhysicalQuantity (not rooted)
  'IFCQUANTITYLENGTH', 'IFCQUANTITYAREA', 'IFCQUANTITYVOLUME', 'IFCQUANTITYCOUNT',
  'IFCQUANTITYWEIGHT', 'IFCQUANTITYTIME', 'IFCQUANTITYNUMBER', 'IFCPHYSICALCOMPLEXQUANTITY',
  // Materials & their constituents (IfcMaterialDefinition — not rooted; lead with a Name)
  'IFCMATERIAL', 'IFCMATERIALPROFILE', 'IFCMATERIALPROFILESET',
  'IFCMATERIALCONSTITUENT', 'IFCMATERIALCONSTITUENTSET',
  // Classification, library & document refs (IfcExternalInformation/Reference)
  'IFCCLASSIFICATION', 'IFCCLASSIFICATIONREFERENCE',
  'IFCLIBRARYINFORMATION', 'IFCLIBRARYREFERENCE', 'IFCEXTERNALREFERENCE',
  'IFCDOCUMENTINFORMATION', 'IFCDOCUMENTREFERENCE',
  // Constraints & approvals (lead with a Name/Identifier)
  'IFCMETRIC', 'IFCOBJECTIVE', 'IFCAPPROVAL', 'IFCTABLE',
  // Actors (IfcPerson/IfcOrganization lead with an Identification string)
  'IFCPERSON', 'IFCORGANIZATION',
  // Presentation layers, styles & text literals (lead with a Name/Literal string)
  'IFCPRESENTATIONLAYERASSIGNMENT', 'IFCPRESENTATIONLAYERWITHSTYLE',
  'IFCSURFACESTYLE', 'IFCCURVESTYLE', 'IFCTEXTSTYLE', 'IFCFILLAREASTYLE',
  'IFCTEXTLITERAL', 'IFCTEXTLITERALWITHEXTENT',
]);

/** True for IfcRelationship subtypes (objectified relationships). */
function isRelationshipType(typeUpper: string): boolean {
  return typeUpper.startsWith('IFCREL');
}

/** Relative tolerance for comparing two length unit scale factors. */
const UNIT_SCALE_TOLERANCE = 1e-6;

/** Lookup tables for matching spatial entities from the first model. */
interface SpatialLookup {
  sitesByName: Map<string, number>;
  buildingsByName: Map<string, number>;
  storeysByName: Map<string, number>;
  storeysByElevation: Array<{ expressId: number; elevation: number }>;
  siteIds: number[];
  buildingIds: number[];
}

/** Shared, model-independent state computed once per merge. */
interface MergeSetup {
  /** ID offset applied to each model's express ids, keyed by model id. */
  modelOffsets: Map<string, number>;
  /** Offset of the first (primary) model — always 0, but kept explicit. */
  firstModelOffset: number;
  /** Infrastructure entities (units, contexts) of the primary model. */
  firstModelInfraMap: Map<string, number[]>;
  /** IfcProject express ids of the primary model. */
  firstProjectIds: number[];
  /** Spatial lookup built from the primary model. */
  spatialLookup: SpatialLookup;
  /** Length unit scale of the primary model — the unit other models merge into. */
  primaryScale: number;
  /** When true, every model is treated as sharing the primary unit. */
  assumeShared: boolean;
}

/** Per-model plan: how this model's entities are remapped, skipped, or restamped. */
interface ModelMergePlan {
  /** Local express id → final express id, for references that must be rewritten. */
  sharedRemap: Map<number, number>;
  /** Local express ids omitted from the output (unified or deduplicated). */
  skipEntityIds: Set<number>;
  /** Local express id → fresh GlobalId, for federated entities whose id collides. */
  guidRewrite: Map<number, string>;
  /** Local express id → original GlobalId (rooted entities only). */
  localGuids: Map<number, string>;
}

/**
 * Where an already-emitted GlobalId landed: its final express id and the unit
 * scale of the model that emitted it. The scale lets a later model decide
 * whether it can truly unify with that instance (same unit space) or must stay
 * distinct (a federated, differently-scaled instance) — see {@link MergedExporter.planModel}.
 */
interface GuidRecord {
  finalId: number;
  scale: number;
}

/**
 * A model to be included in the merge, with its data store and metadata.
 */
export interface MergeModelInput {
  /** Unique model identifier */
  id: string;
  /** Display name */
  name: string;
  /** Parsed IFC data store (must have source buffer) */
  dataStore: IfcDataStore;
  /**
   * Length unit scale of this model — the factor that converts the model's raw
   * IFC length values into base SI metres (`1.0` metres, `0.001` millimetres,
   * `0.3048` feet, …). Optional: when omitted the exporter reads
   * `dataStore.lengthUnitScale`, falling back to `1.0`.
   *
   * The merge compares each model's scale to the first model's to decide
   * whether it can be folded into the unified project (same unit) or must be
   * federated as its own project (different unit). See {@link MergedExporter}.
   */
  lengthUnitScale?: number;
}

/**
 * Options for merged STEP export
 */
export interface MergeExportOptions {
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

  /**
   * Strategy for merging the project hierarchy.
   * - 'keep-first': Keep the first model's IfcProject as the root
   */
  projectStrategy?: 'keep-first';

  /**
   * How to reconcile models whose length unit differs from the first model's.
   *
   * - `'auto'` (default): unit-aware merge. Models that share the first
   *   model's length unit are unified into a single `IfcProject` (spatial
   *   structure and infrastructure deduplicated). A model with a *different*
   *   length unit is federated — it keeps its own `IfcProject`,
   *   `IfcUnitAssignment` and representation contexts so its coordinates stay
   *   correctly scaled, instead of being silently reinterpreted under the
   *   first model's unit. The output then contains more than one `IfcProject`
   *   (a deliberate relaxation of the IfcSingleProjectInstance rule, flagged in
   *   `stats.warnings`) — the only way to preserve mixed units in one file
   *   without rewriting every length-valued attribute.
   * - `'assume-shared'`: treat every model as sharing the first model's unit
   *   (the pre-1332 behaviour). Use only when the caller has already
   *   normalised units; mixing real units under this mode mis-scales geometry.
   */
  unitReconciliation?: 'auto' | 'assume-shared';

  /** Apply visibility filtering to each model before merging */
  visibleOnly?: boolean;
  /** Hidden entity IDs per model (local expressIds) */
  hiddenEntityIdsByModel?: Map<string, Set<number>>;
  /** Isolated entity IDs per model (null = no isolation) */
  isolatedEntityIdsByModel?: Map<string, Set<number> | null>;

  /** Progress callback for async export */
  onProgress?: (progress: ExportProgress) => void;
}

/**
 * Progress information during export
 */
export interface ExportProgress {
  /** Current phase of export */
  phase: 'preparing' | 'entities' | 'assembling';
  /** Progress 0-1 */
  percent: number;
  /** Number of entities processed so far */
  entitiesProcessed: number;
  /** Total entities to process */
  entitiesTotal: number;
  /** Current model being processed (for merged export) */
  currentModel?: string;
}

/**
 * Result of merged STEP export
 */
export interface MergeExportResult {
  /** STEP file content as bytes (avoids V8 string length limit for large files) */
  content: Uint8Array;
  /** Statistics */
  stats: {
    /** Number of models merged */
    modelCount: number;
    /** Total entities in the output */
    totalEntityCount: number;
    /** File size in bytes */
    fileSize: number;
    /**
     * Number of models federated as their own IfcProject because their length
     * unit differed from the first model's. 0 means a single unified project.
     */
    federatedModelCount: number;
    /**
     * Human-readable advisories about the merge (empty on a clean single-unit
     * merge). Notably flags when federation produced more than one IfcProject,
     * which intentionally relaxes the IfcSingleProjectInstance schema rule.
     */
    warnings: string[];
  };
}

/**
 * Merges multiple IFC models into a single STEP file.
 *
 * Uses the same approach as IfcOpenShell's MergeProjects recipe, extended
 * with spatial hierarchy unification and unit-aware federation:
 * 1. First model's entities use their original IDs
 * 2. Subsequent models' IDs are offset to avoid collisions
 * 3. A model that shares the first model's length unit is *unified*: its
 *    IfcProject is remapped to the first model's, spatial structure (Site,
 *    Building, Storey) is unified by name/elevation, and shared infrastructure
 *    (units, contexts) is deduplicated.
 * 4. A model with a *different* length unit is *federated*: it keeps its own
 *    IfcProject, IfcUnitAssignment and representation contexts, so its raw
 *    coordinates remain correctly scaled rather than being reinterpreted under
 *    the first model's unit (the mis-scale bug, issue #1332).
 * 5. GlobalIds are reconciled, not blindly duplicated: a non-relationship
 *    rooted entity that repeats a GlobalId already emitted *in the same unit
 *    space* is unified (references remapped to the one instance). Otherwise —
 *    a federated/different-unit instance, or an objectified relationship whose
 *    payload (RelatedObjects) may differ — it is kept and re-stamped with a
 *    fresh deterministic GlobalId so the file has no duplicate-GlobalId errors
 *    and no relationship membership is lost.
 *
 * Conformance trade-off: when federation triggers, the file contains more than
 * one IfcProject, which intentionally relaxes the IfcSingleProjectInstance
 * EXPRESS rule (SIZEOF(IfcProject) <= 1). This is the only way to keep two
 * different length units in one STEP file without rewriting every length-valued
 * coordinate, and it is strictly better than the previous silent mis-scale.
 * `MergeExportResult.stats.warnings` flags it; pass
 * `unitReconciliation: 'assume-shared'` to force a single project when units
 * are already normalised.
 *
 * Limitation: federation only unifies a model against the *first* model's unit
 * group. Two non-first models that share a unit different from the first are
 * each kept as independent projects (correct, just less deduplicated).
 */
export class MergedExporter {
  private models: MergeModelInput[];

  constructor(models: MergeModelInput[]) {
    if (models.length === 0) {
      throw new Error('MergedExporter requires at least one model');
    }
    this.models = models;
  }

  export(options: MergeExportOptions): MergeExportResult {
    const onProgress = options.onProgress;
    const schema = (options.schema || 'IFC4') as IfcSchemaVersion;
    const header = this.buildHeader(options, schema);
    const setup = this.buildMergeSetup(options);

    const allEntityLines: string[] = [];
    // Tracks every GlobalId already emitted → its final express id + unit scale,
    // so later models can unify against (shared unit) or stay unique from
    // (federated / different unit) it.
    const guidToFinalId = new Map<string, GuidRecord>();
    let isFirstModel = true;
    let federatedModelCount = 0;

    for (const model of this.models) {
      const offset = setup.modelOffsets.get(model.id)!;
      const source = model.dataStore.source;
      if (!source || source.length === 0) continue;

      // Complete view over byId + any deferred property atoms, so the closure
      // walk and the emit loop both reach every entity the source defines.
      const completeIndex = getCompleteEntityIndex(model.dataStore);
      const includedEntityIds = this.computeIncludedEntityIds(model, options, completeIndex, source);

      const modelScale = this.resolveUnitScale(model);
      const compatible = isFirstModel || setup.assumeShared
        || this.unitsCompatible(modelScale, setup.primaryScale);
      if (!isFirstModel && !compatible) federatedModelCount++;
      const plan = this.planModel(model, completeIndex, isFirstModel, compatible, setup, guidToFinalId);

      const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
      for (const [expressId, entityRef] of completeIndex) {
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) continue;
        if (plan.skipEntityIds.has(expressId)) continue;
        const line = this.renderEntity(expressId, entityRef, source, offset, plan, sourceSchema, schema, guidToFinalId, modelScale);
        if (line !== null) allEntityLines.push(line);
      }

      isFirstModel = false;
    }

    // Assemble final file as Uint8Array chunks to avoid V8 string length limit
    if (onProgress) onProgress({ phase: 'assembling', percent: 0.9, entitiesProcessed: allEntityLines.length, entitiesTotal: allEntityLines.length });
    const content = assembleStepBytes(header, allEntityLines);

    return {
      content,
      stats: this.buildStats(allEntityLines.length, content.byteLength, federatedModelCount),
    };
  }

  /**
   * Async export that yields to the event loop between entity chunks,
   * reporting progress via the onProgress callback. This keeps the UI
   * responsive during large merged exports.
   */
  async exportAsync(options: MergeExportOptions): Promise<MergeExportResult> {
    const onProgress = options.onProgress;
    const schema = (options.schema || 'IFC4') as IfcSchemaVersion;
    // See export(): merged files emit an ifc-lite provenance header by policy
    // (no single source header to preserve across federated models).
    const header = this.buildHeader(options, schema);
    const setup = this.buildMergeSetup(options);

    const allEntityLines: string[] = [];
    const guidToFinalId = new Map<string, GuidRecord>();

    // First pass: count total entities for progress
    let totalEntities = 0;
    for (const model of this.models) {
      totalEntities += getCompleteEntityIndex(model.dataStore).size;
    }

    let isFirstModel = true;
    let entitiesProcessed = 0;
    let federatedModelCount = 0;
    const YIELD_INTERVAL = 2000;

    if (onProgress) onProgress({ phase: 'preparing', percent: 0, entitiesProcessed: 0, entitiesTotal: totalEntities });

    for (const model of this.models) {
      const offset = setup.modelOffsets.get(model.id)!;
      const source = model.dataStore.source;
      if (!source || source.length === 0) continue;

      if (onProgress) {
        onProgress({
          phase: 'entities',
          percent: totalEntities > 0 ? (entitiesProcessed / totalEntities) * 0.85 : 0,
          entitiesProcessed,
          entitiesTotal: totalEntities,
          currentModel: model.name,
        });
      }

      const completeIndex = getCompleteEntityIndex(model.dataStore);
      const includedEntityIds = this.computeIncludedEntityIds(model, options, completeIndex, source);

      const modelScale = this.resolveUnitScale(model);
      const compatible = isFirstModel || setup.assumeShared
        || this.unitsCompatible(modelScale, setup.primaryScale);
      if (!isFirstModel && !compatible) federatedModelCount++;
      const plan = this.planModel(model, completeIndex, isFirstModel, compatible, setup, guidToFinalId);
      const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';

      let entityCount = 0;
      for (const [expressId, entityRef] of completeIndex) {
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) continue;
        if (plan.skipEntityIds.has(expressId)) continue;

        const line = this.renderEntity(expressId, entityRef, source, offset, plan, sourceSchema, schema, guidToFinalId, modelScale);
        if (line !== null) allEntityLines.push(line);

        entityCount++;
        entitiesProcessed++;

        // Yield to event loop every YIELD_INTERVAL entities
        if (entityCount % YIELD_INTERVAL === 0) {
          if (onProgress) {
            onProgress({
              phase: 'entities',
              percent: totalEntities > 0 ? (entitiesProcessed / totalEntities) * 0.85 : 0,
              entitiesProcessed,
              entitiesTotal: totalEntities,
              currentModel: model.name,
            });
          }
          await new Promise(r => setTimeout(r, 0));
        }
      }

      isFirstModel = false;
    }

    // Assembly phase
    if (onProgress) {
      onProgress({ phase: 'assembling', percent: 0.9, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    }
    await new Promise(r => setTimeout(r, 0));

    const content = assembleStepBytes(header, allEntityLines);

    if (onProgress) {
      onProgress({ phase: 'assembling', percent: 1, entitiesProcessed: totalEntities, entitiesTotal: totalEntities });
    }

    return {
      content,
      stats: this.buildStats(allEntityLines.length, content.byteLength, federatedModelCount),
    };
  }

  /**
   * Assemble the result stats, including any federation conformance warnings.
   */
  private buildStats(totalEntityCount: number, fileSize: number, federatedModelCount: number): MergeExportResult['stats'] {
    const warnings: string[] = [];
    if (federatedModelCount > 0) {
      warnings.push(
        `${federatedModelCount} model(s) had a length unit differing from the first model and were ` +
        `federated as separate IfcProject roots to keep their geometry correctly scaled. The output ` +
        `therefore contains ${federatedModelCount + 1} IfcProject instances, which intentionally relaxes ` +
        `the IfcSingleProjectInstance rule (SIZEOF(IfcProject) <= 1). Some single-project viewers may ` +
        `only show the first project. Pass unitReconciliation:'assume-shared' to force one project when ` +
        `units are already normalised.`,
      );
    }
    return { modelCount: this.models.length, totalEntityCount, fileSize, federatedModelCount, warnings };
  }

  /**
   * Build the ifc-lite provenance header. Merged files have no single source
   * header to round-trip, so we deliberately emit our own rather than picking
   * one model's FILE_DESCRIPTION arbitrarily.
   */
  private buildHeader(options: MergeExportOptions, schema: IfcSchemaVersion): string {
    return generateHeader({
      schema,
      description: options.description || `Merged export of ${this.models.length} models from ifc-lite`,
      author: options.author || '',
      organization: options.organization || '',
      application: options.application || 'ifc-lite',
      filename: options.filename || 'merged.ifc',
    });
  }

  /**
   * Compute the model-independent state shared by export()/exportAsync():
   * per-model id offsets and the primary model's project/infra/spatial/unit info.
   */
  private buildMergeSetup(options: MergeExportOptions): MergeSetup {
    // Determine ID offsets. Span the COMPLETE entity set (incl. deferred
    // property atoms) so the next model's offset clears every id this model
    // will emit — otherwise a deferred atom at a high id collides.
    let nextAvailableId = 1;
    const modelOffsets = new Map<string, number>();
    for (const model of this.models) {
      modelOffsets.set(model.id, nextAvailableId - 1); // start at nextAvailableId
      nextAvailableId += getMaxExpressId(getCompleteEntityIndex(model.dataStore));
    }

    const firstModel = this.models[0];
    return {
      modelOffsets,
      firstModelOffset: modelOffsets.get(firstModel.id)!,
      firstModelInfraMap: this.findInfrastructureEntities(firstModel.dataStore),
      firstProjectIds: this.findEntitiesByType(firstModel.dataStore, 'IFCPROJECT'),
      spatialLookup: this.buildSpatialLookup(firstModel.dataStore),
      primaryScale: this.resolveUnitScale(firstModel),
      assumeShared: options.unitReconciliation === 'assume-shared',
    };
  }

  /**
   * Resolve a model's length unit scale (raw IFC length → metres). Prefers an
   * explicit `lengthUnitScale` on the input, else the value the parser stamped
   * on the data store, else metres.
   */
  private resolveUnitScale(model: MergeModelInput): number {
    const explicit = model.lengthUnitScale;
    if (typeof explicit === 'number' && explicit > 0) return explicit;
    const fromStore = model.dataStore.lengthUnitScale;
    if (typeof fromStore === 'number' && fromStore > 0) return fromStore;
    return 1.0;
  }

  /** True when two length unit scales are equal within relative tolerance. */
  private unitsCompatible(a: number, b: number): boolean {
    if (a === b) return true;
    const max = Math.max(Math.abs(a), Math.abs(b));
    if (max === 0) return true;
    return Math.abs(a - b) <= max * UNIT_SCALE_TOLERANCE;
  }

  /**
   * Resolve the set of express ids to include for a model under visibility
   * filtering, or `null` when no filtering is requested (include everything).
   */
  private computeIncludedEntityIds(
    model: MergeModelInput,
    options: MergeExportOptions,
    completeIndex: CompleteEntityIndex,
    source: Uint8Array,
  ): Set<number> | null {
    if (!options.visibleOnly) return null;
    const hiddenIds = options.hiddenEntityIdsByModel?.get(model.id) ?? new Set<number>();
    const isolatedIds = options.isolatedEntityIdsByModel?.get(model.id) ?? null;
    const { roots, hiddenProductIds } = getVisibleEntityIds(model.dataStore, hiddenIds, isolatedIds);
    const included = collectReferencedEntityIds(roots, source, completeIndex, hiddenProductIds);
    // Second pass: collect style entities that reference included geometry.
    collectStyleEntities(included, source, {
      byId: completeIndex,
      byType: model.dataStore.entityIndex.byType,
    });
    return included;
  }

  /**
   * Plan how a model's entities are remapped, skipped, or re-stamped, given
   * whether it shares the primary model's length unit (`compatible`).
   *
   * Compatible (or `assume-shared`) models are unified into the primary project:
   * their IfcProject, shared infrastructure, and matching spatial structure are
   * deduplicated, and a rooted entity repeating an already-emitted GlobalId is
   * unified to that one instance.
   *
   * Incompatible (federated) models keep their own project, units, contexts and
   * spatial structure so their coordinates stay correctly scaled; a rooted
   * entity whose GlobalId collides with one already emitted is given a fresh
   * deterministic GlobalId, since the two cannot be the same instance across
   * different unit spaces.
   */
  private planModel(
    model: MergeModelInput,
    completeIndex: CompleteEntityIndex,
    isFirstModel: boolean,
    compatible: boolean,
    setup: MergeSetup,
    guidToFinalId: Map<string, GuidRecord>,
  ): ModelMergePlan {
    const source = model.dataStore.source!;
    const sharedRemap = new Map<number, number>();
    const skipEntityIds = new Set<number>();
    const guidRewrite = new Map<number, string>();

    // One cheap pass to read each rooted entity's GlobalId (first attribute).
    const localGuids = new Map<number, string>();
    for (const [id, ref] of completeIndex) {
      const guid = this.extractGlobalIdFast(ref, source);
      if (guid !== null) localGuids.set(id, guid);
    }

    if (!isFirstModel && compatible) {
      // Remap this model's IfcProject references → first model's IfcProject.
      const projectIds = this.findEntitiesByType(model.dataStore, 'IFCPROJECT');
      if (setup.firstProjectIds.length > 0) {
        for (const pid of projectIds) {
          sharedRemap.set(pid, setup.firstProjectIds[0] + setup.firstModelOffset);
          skipEntityIds.add(pid);
        }
      }

      // Remap and skip duplicate infrastructure (units, contexts).
      const modelInfra = this.findInfrastructureEntities(model.dataStore);
      for (const [type, firstIds] of setup.firstModelInfraMap) {
        const thisIds = modelInfra.get(type);
        if (thisIds && firstIds.length > 0 && thisIds.length > 0) {
          sharedRemap.set(thisIds[0], firstIds[0] + setup.firstModelOffset);
          skipEntityIds.add(thisIds[0]);
        }
      }

      // Unify spatial hierarchy: match Site, Building, Storey to first model.
      this.unifySpatialEntities(model.dataStore, setup.spatialLookup, setup.firstModelOffset, sharedRemap, skipEntityIds);

      // Skip IfcRelAggregates that become fully redundant after unification.
      this.skipRedundantRelAggregates(model.dataStore, sharedRemap, skipEntityIds);
    }

    if (!isFirstModel) {
      // GlobalId reconciliation against everything emitted by earlier models.
      const pendingMinted = new Set<string>();
      for (const [id, guid] of localGuids) {
        if (skipEntityIds.has(id)) continue; // already unified/deduped above
        const prior = guidToFinalId.get(guid);
        if (prior === undefined) continue; // first occurrence — kept as-is

        // Unify (drop + remap refs to the one instance) ONLY when this is a
        // physical/spatial root AND both this model and the emitter share the
        // primary unit. Two conditions force "keep + re-stamp" instead:
        //   - Objectified relationships (IfcRel*): same GlobalId does not imply
        //     the same membership (e.g. a storey-containment listing different
        //     elements per discipline), so dropping one would orphan elements.
        //   - The colliding instance was emitted in a different unit space
        //     (a federated model), so unifying would reinterpret coordinates —
        //     the very mis-scale this fix prevents, reached transitively.
        const type = (completeIndex.get(id)?.type ?? '').toUpperCase();
        const emitterIsPrimaryUnit = this.unitsCompatible(prior.scale, setup.primaryScale);
        const canUnify = compatible && emitterIsPrimaryUnit && !isRelationshipType(type);
        if (canUnify) {
          sharedRemap.set(id, prior.finalId);
          skipEntityIds.add(id);
        } else {
          guidRewrite.set(id, this.mintUniqueGuid(guid, model.id, guidToFinalId, pendingMinted));
        }
      }
    }

    return { sharedRemap, skipEntityIds, guidRewrite, localGuids };
  }

  /**
   * Render one source entity into its final STEP line: apply id offset + shared
   * remaps, re-stamp a federated GlobalId if needed, apply schema conversion,
   * and register the emitted GlobalId so later models can reconcile against it.
   * Returns `null` when schema conversion drops the entity.
   */
  private renderEntity(
    localId: number,
    entityRef: ExportEntityRef,
    source: Uint8Array,
    offset: number,
    plan: ModelMergePlan,
    sourceSchema: IfcSchemaVersion,
    targetSchema: IfcSchemaVersion,
    guidToFinalId: Map<string, GuidRecord>,
    modelScale: number,
  ): string | null {
    const entityText = safeUtf8Decode(source, entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength);

    // Remap ids. Fast path: the first model (offset 0, no remaps) is byte-identical.
    let finalText: string;
    if (offset === 0 && plan.sharedRemap.size === 0) {
      finalText = entityText;
    } else {
      finalText = this.remapEntityText(entityText, offset, plan.sharedRemap);
    }

    // Re-stamp the GlobalId for a federated entity whose id collides.
    const mintedGuid = plan.guidRewrite.get(localId);
    if (mintedGuid !== undefined) {
      finalText = this.replaceGlobalId(finalText, mintedGuid);
    }

    if (needsConversion(sourceSchema, targetSchema)) {
      const converted = convertStepLine(finalText, sourceSchema, targetSchema);
      if (converted === null) return null;
      finalText = converted;
    }

    // Record the emitted GlobalId → final express id + unit scale, for rooted
    // entities only. Read it from the FINAL line, not the source: schema
    // conversion can replace an unsupported rooted type with an IFCPROXY that
    // carries a freshly-minted GlobalId, so the source guid would be stale.
    // Emitted entities are not sharedRemap keys, so their final id is
    // localId + offset.
    if (plan.localGuids.has(localId)) {
      const emittedGuid = this.readLeadingGuid(finalText)
        ?? mintedGuid ?? plan.localGuids.get(localId);
      if (emittedGuid !== undefined) {
        guidToFinalId.set(emittedGuid, { finalId: localId + offset, scale: modelScale });
      }
    }

    return finalText;
  }

  /**
   * Read the GlobalId (first quoted attribute) from an already-rendered STEP
   * line. Used to register the id that was actually emitted, after any id
   * remap, GlobalId re-stamp, or schema conversion. Returns null if the first
   * quoted token is not a 22-char GlobalId.
   */
  private readLeadingGuid(entityText: string): string | null {
    const open = entityText.indexOf('(');
    if (open === -1) return null;
    const q1 = entityText.indexOf("'", open + 1);
    if (q1 === -1) return null;
    const q2 = entityText.indexOf("'", q1 + 1);
    if (q2 === -1) return null;
    const raw = entityText.slice(q1 + 1, q2);
    return GLOBAL_ID_RE.test(raw) ? raw : null;
  }

  /**
   * Mint a fresh, deterministic, collision-free GlobalId for an entity whose id
   * collides. Seeded from the original GlobalId and the model's stable id so the
   * output is reproducible and does not churn when an unrelated earlier model
   * changes size; checked against both already-emitted ids and the ids minted
   * so far for this model.
   */
  private mintUniqueGuid(
    original: string,
    modelId: string,
    guidToFinalId: Map<string, GuidRecord>,
    pendingMinted: Set<string>,
  ): string {
    let candidate = deterministicGlobalId(`${original}#${modelId}`);
    let n = 0;
    while (guidToFinalId.has(candidate) || pendingMinted.has(candidate)) {
      candidate = deterministicGlobalId(`${original}#${modelId}#${n++}`);
    }
    pendingMinted.add(candidate);
    return candidate;
  }

  /**
   * Read an entity's GlobalId (first attribute) by decoding only its head.
   * Returns the 22-char id for a rooted entity, or `null` for any entity whose
   * first attribute is not a GlobalId (geometry, lists, property atoms, …).
   */
  private extractGlobalIdFast(ref: ExportEntityRef, source: Uint8Array): string | null {
    // Non-rooted resource entities (property/quantity/material/style/actor …)
    // lead with a Name string that can itself be 22 charset chars; never treat
    // those as a GlobalId or reconciliation would drop/rename them.
    if (NON_ROOTED_STRING_TYPES.has((ref.type ?? '').toUpperCase())) return null;
    // 128 bytes comfortably spans `#<id>=<LONGEST_TYPE_NAME>('<22-char id>'`,
    // so the GlobalId is always fully inside the window.
    const end = Math.min(ref.byteOffset + 128, ref.byteOffset + ref.byteLength);
    const head = safeUtf8Decode(source, ref.byteOffset, end);
    const open = head.indexOf('(');
    if (open === -1) return null;
    let i = open + 1;
    while (i < head.length && (head[i] === ' ' || head[i] === '\t' || head[i] === '\n' || head[i] === '\r')) i++;
    if (head[i] !== "'") return null;
    // A GlobalId never contains a quote (charset excludes it), so the next
    // quote closes it.
    const close = head.indexOf("'", i + 1);
    if (close === -1) return null;
    const raw = head.slice(i + 1, close);
    return GLOBAL_ID_RE.test(raw) ? raw : null;
  }

  /**
   * Replace an entity's GlobalId (first quoted attribute) with `newGuid`.
   * `newGuid` is a 22-char IFC id (no quote in its charset), so this is safe.
   */
  private replaceGlobalId(entityText: string, newGuid: string): string {
    const open = entityText.indexOf('(');
    if (open === -1) return entityText;
    const q1 = entityText.indexOf("'", open + 1);
    if (q1 === -1) return entityText;
    const q2 = entityText.indexOf("'", q1 + 1);
    if (q2 === -1) return entityText;
    return entityText.slice(0, q1 + 1) + newGuid + entityText.slice(q2);
  }

  /**
   * Remap all #ID references in a STEP entity line.
   * Applies offset to all IDs, then overrides with specific remappings.
   *
   * Only `#<digits>` tokens in code positions are rewritten; tokens inside
   * single-quoted STEP strings (e.g. a 'Room #205' Name or a 'http://x#42'
   * URL) are left untouched so string attribute values are not corrupted.
   */
  private remapEntityText(
    entityText: string,
    offset: number,
    sharedRemap: Map<number, number>,
  ): string {
    const remapId = (originalId: number): string => {
      // Check if this ID has a specific remap (project, shared infrastructure)
      const remapped = sharedRemap.get(originalId);
      if (remapped !== undefined) {
        return `#${remapped}`;
      }
      // Apply offset
      return `#${originalId + offset}`;
    };

    let out = '';
    let inString = false;
    for (let i = 0; i < entityText.length; i++) {
      const char = entityText[i];

      if (inString) {
        out += char;
        if (char === "'") {
          // STEP escapes a literal quote by doubling it ('').
          if (entityText[i + 1] === "'") {
            out += entityText[i + 1];
            i++;
          } else {
            inString = false;
          }
        }
        continue;
      }

      if (char === "'") {
        inString = true;
        out += char;
        continue;
      }

      if (char === '#' && entityText[i + 1] >= '0' && entityText[i + 1] <= '9') {
        let j = i + 1;
        while (j < entityText.length && entityText[j] >= '0' && entityText[j] <= '9') j++;
        const originalId = parseInt(entityText.slice(i + 1, j), 10);
        out += remapId(originalId);
        i = j - 1;
        continue;
      }

      out += char;
    }
    return out;
  }

  /**
   * Find entity IDs of shared infrastructure types in a data store.
   * Returns a map of uppercase type name → array of expressIds.
   */
  private findInfrastructureEntities(
    dataStore: IfcDataStore,
  ): Map<string, number[]> {
    const result = new Map<string, number[]>();

    for (const type of SHARED_INFRASTRUCTURE_TYPES) {
      const ids = dataStore.entityIndex.byType.get(type) ?? [];
      if (ids.length > 0) {
        result.set(type, [...ids]);
      }
    }

    return result;
  }

  /**
   * Find entity IDs of a specific type in a data store.
   */
  private findEntitiesByType(dataStore: IfcDataStore, typeUpper: string): number[] {
    return dataStore.entityIndex.byType.get(typeUpper) ?? [];
  }

  /**
   * Build lookup tables from the first model's spatial entities for
   * matching against subsequent models during merge.
   */
  private buildSpatialLookup(dataStore: IfcDataStore): SpatialLookup {
    const lookup: SpatialLookup = {
      sitesByName: new Map(),
      buildingsByName: new Map(),
      storeysByName: new Map(),
      storeysByElevation: [],
      siteIds: [],
      buildingIds: [],
    };

    for (const id of this.findEntitiesByType(dataStore, 'IFCSITE')) {
      lookup.siteIds.push(id);
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.sitesByName.set(name.toLowerCase(), id);
    }

    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDING')) {
      lookup.buildingIds.push(id);
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.buildingsByName.set(name.toLowerCase(), id);
    }

    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDINGSTOREY')) {
      const name = this.extractEntityName(id, dataStore);
      if (name) lookup.storeysByName.set(name.toLowerCase(), id);
      const elevation = this.extractStoreyElevation(id, dataStore);
      if (elevation !== undefined) {
        lookup.storeysByElevation.push({ expressId: id, elevation });
      }
    }

    return lookup;
  }

  /**
   * Match a subsequent model's spatial entities (Site, Building, Storey)
   * to the first model's equivalents. Matched entities are remapped and
   * their duplicate entity is skipped from output.
   *
   * Matching strategy:
   * - Sites/Buildings: by name (case-insensitive), or if only one in each model
   * - Storeys: by name first, then by elevation (tolerance ±0.5 model units)
   */
  private unifySpatialEntities(
    dataStore: IfcDataStore,
    lookup: SpatialLookup,
    firstModelOffset: number,
    sharedRemap: Map<number, number>,
    skipEntityIds: Set<number>,
  ): void {
    // Unify IfcSite
    const sites = this.findEntitiesByType(dataStore, 'IFCSITE');
    for (const id of sites) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;
      if (name) match = lookup.sitesByName.get(name.toLowerCase());
      // If single site in both models, unify regardless of name
      if (match === undefined && sites.length === 1 && lookup.siteIds.length === 1) {
        match = lookup.siteIds[0];
      }
      if (match !== undefined) {
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuilding
    const buildings = this.findEntitiesByType(dataStore, 'IFCBUILDING');
    for (const id of buildings) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;
      if (name) match = lookup.buildingsByName.get(name.toLowerCase());
      if (match === undefined && buildings.length === 1 && lookup.buildingIds.length === 1) {
        match = lookup.buildingIds[0];
      }
      if (match !== undefined) {
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuildingStorey — name match first, then elevation fallback
    const matchedFirstStoreys = new Set<number>();
    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDINGSTOREY')) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;

      // Try name match
      if (name) {
        const candidate = lookup.storeysByName.get(name.toLowerCase());
        if (candidate !== undefined && !matchedFirstStoreys.has(candidate)) {
          match = candidate;
        }
      }

      // Fallback: match by elevation
      if (match === undefined) {
        const elevation = this.extractStoreyElevation(id, dataStore);
        if (elevation !== undefined) {
          for (const entry of lookup.storeysByElevation) {
            if (matchedFirstStoreys.has(entry.expressId)) continue;
            const tolerance = Math.max(0.5, Math.abs(entry.elevation) * 0.01);
            if (Math.abs(elevation - entry.elevation) <= tolerance) {
              match = entry.expressId;
              break;
            }
          }
        }
      }

      if (match !== undefined) {
        matchedFirstStoreys.add(match);
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }
  }

  /**
   * Skip IfcRelAggregates that become fully redundant after spatial unification.
   *
   * When Model2's `IfcRelAggregates(Project, (Site))` gets remapped to
   * `IfcRelAggregates(FirstProject, (FirstSite))`, it duplicates Model1's
   * existing relationship, causing viewers to show Site multiple times.
   *
   * An IfcRelAggregates is redundant if both its RelatingObject (attr 4)
   * and ALL its RelatedObjects (attr 5) were remapped via sharedRemap.
   */
  private skipRedundantRelAggregates(
    dataStore: IfcDataStore,
    sharedRemap: Map<number, number>,
    skipEntityIds: Set<number>,
  ): void {
    for (const relId of this.findEntitiesByType(dataStore, 'IFCRELAGGREGATES')) {
      // RelatingObject is attr 4 — single #ref
      const relatingAttr = this.extractStepAttribute(relId, dataStore, 4);
      if (!relatingAttr) continue;
      const relatingRef = relatingAttr.match(/^#(\d+)$/);
      if (!relatingRef || !sharedRemap.has(parseInt(relatingRef[1], 10))) continue;

      // RelatedObjects is attr 5 — list of #refs like (#2,#3)
      const relatedAttr = this.extractStepAttribute(relId, dataStore, 5);
      if (!relatedAttr) continue;
      const refs: number[] = [];
      const refRegex = /#(\d+)/g;
      let m;
      while ((m = refRegex.exec(relatedAttr)) !== null) {
        refs.push(parseInt(m[1], 10));
      }
      if (refs.length === 0) continue;

      // If ALL related objects were also remapped, this rel is fully redundant
      if (refs.every(ref => sharedRemap.has(ref))) {
        skipEntityIds.add(relId);
      }
    }
  }

  /**
   * Extract the Name attribute (index 2) from a STEP entity.
   */
  private extractEntityName(
    expressId: number,
    dataStore: IfcDataStore,
  ): string | null {
    const attr = this.extractStepAttribute(expressId, dataStore, 2);
    if (!attr || attr === '$') return null;
    if (attr.startsWith("'") && attr.endsWith("'")) {
      const raw = attr.slice(1, -1).replace(/''/g, "'");
      return decodeIfcString(raw);
    }
    return null;
  }

  /**
   * Extract the Elevation attribute (index 9) from an IfcBuildingStorey.
   */
  private extractStoreyElevation(
    expressId: number,
    dataStore: IfcDataStore,
  ): number | undefined {
    const attr = this.extractStepAttribute(expressId, dataStore, 9);
    if (!attr || attr === '$') return undefined;
    // Handle typed value like IFCLENGTHMEASURE(3000.)
    const typedMatch = attr.match(/^[A-Z_]+\(([^)]+)\)$/i);
    const numStr = typedMatch ? typedMatch[1] : attr;
    const num = parseFloat(numStr);
    return isNaN(num) ? undefined : num;
  }

  /**
   * Extract a specific attribute (by 0-based index) from a STEP entity's
   * raw text. Returns the raw string value (e.g., "'Name'", "$", "#123").
   */
  private extractStepAttribute(
    expressId: number,
    dataStore: IfcDataStore,
    attrIndex: number,
  ): string | null {
    const source = dataStore.source;
    if (!source) return null;
    const ref = dataStore.entityIndex.byId.get(expressId);
    if (!ref) return null;

    const entityText = safeUtf8Decode(
      source, ref.byteOffset, ref.byteOffset + ref.byteLength,
    );

    // Find opening paren after type name
    const openParen = entityText.indexOf('(');
    if (openParen === -1) return null;

    let depth = 0;
    let attrCount = 0;
    let attrStart = openParen + 1;
    let inString = false;

    for (let i = openParen + 1; i < entityText.length; i++) {
      const ch = entityText[i];

      if (ch === "'" && !inString) {
        inString = true;
      } else if (ch === "'" && inString) {
        // Check for escaped quote ''
        if (i + 1 < entityText.length && entityText[i + 1] === "'") {
          i++;
          continue;
        }
        inString = false;
      } else if (!inString) {
        if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          if (depth === 0) {
            return attrCount === attrIndex
              ? entityText.substring(attrStart, i).trim()
              : null;
          }
          depth--;
        } else if (ch === ',' && depth === 0) {
          if (attrCount === attrIndex) {
            return entityText.substring(attrStart, i).trim();
          }
          attrCount++;
          attrStart = i + 1;
        }
      }
    }

    return null;
  }

}

