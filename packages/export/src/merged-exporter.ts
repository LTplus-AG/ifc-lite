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
import { generateHeader, deterministicGlobalId, IfcParser } from '@ifc-lite/parser';
import { decodeIfcString } from '@ifc-lite/encoding';
import { safeUtf8Decode } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { collectReferencedEntityIds, getVisibleEntityIds, collectStyleEntities } from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { assembleStepBytes, assembleStepBlob } from './step-serialization.js';
import { getCompleteEntityIndex, getMaxExpressId, type CompleteEntityIndex, type ExportEntityRef } from './entity-iteration.js';
import { StepExporter } from './step-exporter.js';
import { rescaleEntityLengths, computeNormalizeFactor } from './unit-normalize.js';

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

/** SI prefix multipliers, for resolving prefixed area/volume units (rarely used). */
const SI_PREFIX_MULTIPLIERS: Record<string, number> = {
  ATTO: 1e-18, FEMTO: 1e-15, PICO: 1e-12, NANO: 1e-9, MICRO: 1e-6, MILLI: 1e-3,
  CENTI: 1e-2, DECI: 1e-1, DECA: 1e1, HECTO: 1e2, KILO: 1e3, MEGA: 1e6,
  GIGA: 1e9, TERA: 1e12, PETA: 1e15, EXA: 1e18,
};

/** Source schemas the IFC4 length registry does not fully cover (see #1475 review). */
const NORMALIZE_UNCOVERED_SCHEMAS = new Set(['IFC4X3', 'IFC5']);

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
  /** Area unit scale (m² per unit) of the primary model — target for area values. */
  primaryAreaScale: number;
  /** Volume unit scale (m³ per unit) of the primary model — target for volume values. */
  primaryVolumeScale: number;
  /** When true, every model is treated as sharing the primary unit. */
  assumeShared: boolean;
  /**
   * When true, a differing-unit model is rescaled into the primary unit and then
   * unified into the primary project (rather than federated).
   */
  normalize: boolean;
  /** Spatial matching strategy for IfcSite — see {@link MergeExportOptions.mergeSites}. */
  mergeSites?: 'single' | 'by-name';
  /** Spatial matching strategy for IfcBuilding — see {@link MergeExportOptions.mergeBuildings}. */
  mergeBuildings?: 'single' | 'by-name';
  /** Spatial matching strategy for IfcBuildingStorey — see {@link MergeExportOptions.mergeStoreys}. */
  mergeStoreys?: 'by-name' | 'by-elevation' | 'by-name-then-elevation';
}

/**
 * How one model folds into the merge, decided from its units and the
 * reconciliation mode. See {@link MergedExporter.resolveModelMode}.
 *
 * Length, area and volume carry *independent* factors: IFC declares
 * `AREAUNIT`/`VOLUMEUNIT` separately from `LENGTHUNIT` (e.g. millimetre lengths
 * with square-/cubic-metre areas), so an area is not simply the length factor
 * squared.
 */
interface ModelMode {
  /**
   * True when the model is unified into the primary project (its project, units,
   * contexts and matching spatial structure are deduplicated). False federates it.
   */
  compatible: boolean;
  /** Factor applied to every length-valued datum before emit (`1` = no rescale). */
  lengthFactor: number;
  /** Factor applied to every area-valued datum before emit (`1` = no rescale). */
  areaFactor: number;
  /** Factor applied to every volume-valued datum before emit (`1` = no rescale). */
  volumeFactor: number;
  /**
   * Unit space the model's emitted entities end up in — the primary scale when
   * normalized/compatible, else the model's own scale. Recorded with each emitted
   * GlobalId so later models reconcile against the right unit space.
   */
  effectiveScale: number;
  /** True when this (non-primary) model was rescaled into the primary unit. */
  normalized: boolean;
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

  /**
   * Pending edits for this model — property / attribute / quantity / retype /
   * positional mutations and overlay-created entities. When present and
   * non-empty, {@link MergedExporter.exportAsync} bakes them into the model
   * (via {@link StepExporter}) before merging, so federated export round-trips
   * edits exactly like single-model export. Empty or absent views cost nothing.
   *
   * Only honoured by the async `exportAsync` path: baking re-parses the edited
   * bytes, which needs the async parser. The synchronous {@link MergedExporter.export}
   * throws if any model carries pending edits.
   */
  mutationView?: MutablePropertyView;
}

/**
 * True when a mutation view carries pending edits the exporter would bake.
 *
 * Keys off the view's *current overlay footprint* (`hasPendingChanges`), not the
 * append-only mutation history: the history never shrinks, so an
 * edited-then-undone model would keep reporting changes and force a redundant
 * re-bake. `hasPendingChanges` is a conservative over-approximation (the safe
 * direction here — under-reporting would silently drop edits). Falls back to the
 * legacy history/new-entity check for views that predate the method.
 */
function viewHasMutations(view: MutablePropertyView | undefined): boolean {
  if (!view) return false;
  if (typeof view.hasPendingChanges === 'function') return view.hasPendingChanges();
  // Legacy fallback (older MutablePropertyView without hasPendingChanges).
  const muts = typeof view.getMutations === 'function' ? view.getMutations() : [];
  if (muts.length > 0) return true;
  const created = typeof view.getNewEntities === 'function' ? view.getNewEntities() : [];
  return created.length > 0;
}

/**
 * Drop models with no usable source (nothing to emit): a cache-restored or
 * metadata-only store can reach the merge with an empty `.source`. The emit loop
 * already skips them, but the primary model (`models[0]`) and the unit/offset
 * setup must be computed over the SAME set — otherwise an empty model at index 0
 * would poison the primary unit/scale that later models normalize against. When
 * every model is empty the original list is kept so a valid (empty) file is still
 * produced rather than throwing.
 */
function withUsableSource(models: MergeModelInput[]): MergeModelInput[] {
  const usable = models.filter(m => m.dataStore.source && m.dataStore.source.length > 0);
  return usable.length > 0 ? usable : models;
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
   * - `'normalize'`: single-unit merge. A model with a *different* length unit
   *   is *rescaled* — every length-valued datum (all `IfcCartesianPoint`
   *   coordinates, extrusion depths, profile dimensions, radii, thicknesses,
   *   storey elevations, placement offsets, `IfcLengthMeasure` property values,
   *   `IfcQuantityLength`/`Area`/`Volume`, …) is converted from its own unit
   *   into the first model's unit — and then unified into the single first
   *   `IfcProject` (its `IfcUnitAssignment` and contexts deduplicated). The
   *   output is one ordinary single-unit IFC that opens correctly everywhere
   *   (BIM Vision included). Angles, ratios, counts and georeferencing offsets
   *   are left as-is. Area/volume values assume the SI-derived unit
   *   (square/cube of the length unit). See {@link ./unit-normalize.ts} for the
   *   exact set of rescaled attributes.
   * - `'assume-shared'`: treat every model as sharing the first model's unit
   *   (the pre-1332 behaviour). Use only when the caller has already
   *   normalised units; mixing real units under this mode mis-scales geometry.
   */
  unitReconciliation?: 'auto' | 'normalize' | 'assume-shared';

  /**
   * How IfcSite instances are matched across models for spatial unification
   * (mirrors IfcOpenShell/BlenderBIM's "Merge Projects" recipe). Omitted
   * (default) keeps today's combined heuristic: match by Name
   * (case-insensitive), else unify when both models contribute exactly one
   * site.
   *
   * - `'single'`: unify only when each model contributes exactly one
   *   IfcSite — Name is ignored entirely.
   * - `'by-name'`: unify only sites with a matching Name; a lone,
   *   differently-named site in each model is kept as two separate roots.
   */
  mergeSites?: 'single' | 'by-name';

  /** Same matching strategy as {@link mergeSites}, applied to IfcBuilding. */
  mergeBuildings?: 'single' | 'by-name';

  /**
   * How IfcBuildingStorey instances are matched across models. Omitted
   * (default) is `'by-name-then-elevation'` — today's behavior.
   *
   * - `'by-name'`: match only by Name (case-insensitive); no elevation
   *   fallback.
   * - `'by-elevation'`: match only by Elevation (±0.5 model-unit tolerance,
   *   same as today), ignoring Name entirely.
   * - `'by-name-then-elevation'`: try Name first, fall back to Elevation.
   */
  mergeStoreys?: 'by-name' | 'by-elevation' | 'by-name-then-elevation';

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
     * Number of models whose length-valued data was rescaled into the first
     * model's unit under `unitReconciliation: 'normalize'`. 0 for the other
     * modes (or when every model already shared the first model's unit).
     */
    normalizedModelCount: number;
    /**
     * Human-readable advisories about the merge (empty on a clean single-unit
     * merge). Notably flags when federation produced more than one IfcProject,
     * which intentionally relaxes the IfcSingleProjectInstance schema rule.
     */
    warnings: string[];
  };
}

/**
 * Result of a merged STEP export assembled as an off-heap {@link Blob}
 * ({@link MergedExporter.exportBlobAsync}) instead of one contiguous
 * `Uint8Array`. Same stats as {@link MergeExportResult}; only the content
 * container differs. Suited for the browser download path, where the merged
 * file (the largest STEP output — every federated model concatenated) is
 * handed straight to `downloadBlob` with no contiguous buffer materialised.
 */
export interface MergeBlobExportResult {
  /** STEP file content as a multi-part Blob (never assembled into one buffer). */
  content: Blob;
  /** Statistics about the export (identical shape to {@link MergeExportResult}). */
  stats: MergeExportResult['stats'];
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
 * Conformance trade-off: when federation triggers (under the default `'auto'`),
 * the file contains more than one IfcProject, which intentionally relaxes the
 * IfcSingleProjectInstance EXPRESS rule (SIZEOF(IfcProject) <= 1). This preserves
 * both units without rewriting coordinates, and is strictly better than a silent
 * mis-scale. `MergeExportResult.stats.warnings` flags it. To instead get one
 * ordinary single-unit IfcProject, pass `unitReconciliation: 'normalize'` — it
 * rescales every length-valued datum of the differing-unit models into the first
 * model's unit (see {@link ./unit-normalize.ts}). Use `'assume-shared'` only when
 * the caller has already normalised units.
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

    // Baking edits into source bytes needs the async parser, so the sync path
    // cannot honour them. Fail loudly rather than silently dropping the edits.
    if (this.models.some(m => viewHasMutations(m.mutationView))) {
      throw new Error(
        'MergedExporter.export() cannot apply pending edits — baking needs the async parser. ' +
        'Use exportAsync() for merged export with mutations.',
      );
    }
    const models = withUsableSource(this.models);
    const setup = this.buildMergeSetup(options, models);

    const allEntityLines: string[] = [];
    // Tracks every GlobalId already emitted → its final express id + unit scale,
    // so later models can unify against (shared unit) or stay unique from
    // (federated / different unit) it.
    const guidToFinalId = new Map<string, GuidRecord>();
    let isFirstModel = true;
    let federatedModelCount = 0;
    let normalizedModelCount = 0;
    const normalizeWarnings = new Set<string>();

    for (const model of models) {
      const offset = setup.modelOffsets.get(model.id)!;
      const source = model.dataStore.source;
      if (!source || source.length === 0) continue;

      // Complete view over byId + any deferred property atoms, so the closure
      // walk and the emit loop both reach every entity the source defines.
      const completeIndex = getCompleteEntityIndex(model.dataStore);
      const includedEntityIds = this.computeIncludedEntityIds(model, options, completeIndex, source);

      const mode = this.resolveModelMode(model, isFirstModel, setup);
      if (!isFirstModel && !mode.compatible) federatedModelCount++;
      if (mode.normalized) { normalizedModelCount++; this.collectNormalizeCaveats(model, normalizeWarnings); }
      const plan = this.planModel(model, completeIndex, isFirstModel, mode.compatible, mode.lengthFactor, setup, guidToFinalId);

      const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
      for (const [expressId, entityRef] of completeIndex) {
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) continue;
        if (plan.skipEntityIds.has(expressId)) continue;
        const line = this.renderEntity(expressId, entityRef, source, offset, plan, sourceSchema, schema, guidToFinalId, mode);
        if (line !== null) allEntityLines.push(line);
      }

      isFirstModel = false;
    }

    // Assemble final file as Uint8Array chunks to avoid V8 string length limit
    if (onProgress) onProgress({ phase: 'assembling', percent: 0.9, entitiesProcessed: allEntityLines.length, entitiesTotal: allEntityLines.length });
    const content = assembleStepBytes(header, allEntityLines);

    return {
      content,
      stats: this.buildStats(allEntityLines.length, content.byteLength, federatedModelCount, normalizedModelCount, normalizeWarnings),
    };
  }

  /**
   * Async export that yields to the event loop between entity chunks,
   * reporting progress via the onProgress callback. This keeps the UI
   * responsive during large merged exports.
   */
  async exportAsync(options: MergeExportOptions): Promise<MergeExportResult> {
    const doc = await this.collectMergedDocument(options);
    const content = assembleStepBytes(doc.header, doc.allEntityLines);
    if (options.onProgress) {
      options.onProgress({ phase: 'assembling', percent: 1, entitiesProcessed: doc.totalEntities, entitiesTotal: doc.totalEntities });
    }
    return {
      content,
      stats: this.buildStats(doc.allEntityLines.length, content.byteLength, doc.federatedModelCount, doc.normalizedModelCount, doc.normalizeWarnings),
    };
  }

  /**
   * Like {@link exportAsync}, but assembles the merged STEP file as an
   * off-heap multi-part {@link Blob} (via {@link assembleStepBlob}) rather
   * than one contiguous `Uint8Array`. The merged file is the largest STEP
   * output ifc-lite produces (every federated model concatenated), so
   * skipping the final contiguous buffer is where the memory saving matters
   * most; the browser download path hands the Blob straight to `downloadBlob`
   * with no `Uint8Array`-to-`BlobPart` copy. Byte content is identical to
   * {@link exportAsync}.
   */
  async exportBlobAsync(options: MergeExportOptions): Promise<MergeBlobExportResult> {
    const doc = await this.collectMergedDocument(options);
    const content = assembleStepBlob(doc.header, doc.allEntityLines);
    if (options.onProgress) {
      options.onProgress({ phase: 'assembling', percent: 1, entitiesProcessed: doc.totalEntities, entitiesTotal: doc.totalEntities });
    }
    return {
      content,
      stats: this.buildStats(doc.allEntityLines.length, content.size, doc.federatedModelCount, doc.normalizedModelCount, doc.normalizeWarnings),
    };
  }

  /**
   * Shared work of {@link exportAsync} / {@link exportBlobAsync}: bake pending
   * edits, plan the merge, and render every entity line (yielding to the event
   * loop between chunks so the UI stays responsive). Returns the header, the
   * rendered entity lines, and the counters the stats builder needs — the two
   * public methods differ only in how they turn these into a final container
   * (`Uint8Array` vs off-heap `Blob`), so the entity-rendering logic lives here
   * once and can't drift between them.
   */
  private async collectMergedDocument(options: MergeExportOptions): Promise<{
    header: string;
    allEntityLines: string[];
    federatedModelCount: number;
    normalizedModelCount: number;
    normalizeWarnings: Set<string>;
    totalEntities: number;
  }> {
    const onProgress = options.onProgress;
    const schema = (options.schema || 'IFC4') as IfcSchemaVersion;
    // See export(): merged files emit an ifc-lite provenance header by policy
    // (no single source header to preserve across federated models).
    const header = this.buildHeader(options, schema);

    // Bake each model's pending edits into its source bytes before merging, so
    // federated export round-trips mutations like single-model export. Models
    // without edits pass through unchanged (no export/parse cost).
    const models = withUsableSource(await this.bakeMutatedModels());
    const setup = this.buildMergeSetup(options, models);

    const allEntityLines: string[] = [];
    const guidToFinalId = new Map<string, GuidRecord>();

    // First pass: count total entities for progress
    let totalEntities = 0;
    for (const model of models) {
      totalEntities += getCompleteEntityIndex(model.dataStore).size;
    }

    let isFirstModel = true;
    let entitiesProcessed = 0;
    let federatedModelCount = 0;
    let normalizedModelCount = 0;
    const normalizeWarnings = new Set<string>();
    const YIELD_INTERVAL = 2000;

    if (onProgress) onProgress({ phase: 'preparing', percent: 0, entitiesProcessed: 0, entitiesTotal: totalEntities });

    for (const model of models) {
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

      const mode = this.resolveModelMode(model, isFirstModel, setup);
      if (!isFirstModel && !mode.compatible) federatedModelCount++;
      if (mode.normalized) { normalizedModelCount++; this.collectNormalizeCaveats(model, normalizeWarnings); }
      const plan = this.planModel(model, completeIndex, isFirstModel, mode.compatible, mode.lengthFactor, setup, guidToFinalId);
      const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';

      let entityCount = 0;
      for (const [expressId, entityRef] of completeIndex) {
        if (includedEntityIds !== null && !includedEntityIds.has(expressId)) continue;
        if (plan.skipEntityIds.has(expressId)) continue;

        const line = this.renderEntity(expressId, entityRef, source, offset, plan, sourceSchema, schema, guidToFinalId, mode);
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

    return { header, allEntityLines, federatedModelCount, normalizedModelCount, normalizeWarnings, totalEntities };
  }

  /**
   * Bake each model's pending edits into its source bytes before merging.
   *
   * A model with a non-empty {@link MergeModelInput.mutationView} is run through
   * {@link StepExporter} in its own source schema (mutations applied, geometry +
   * quantities kept), and the resulting bytes are re-parsed into a fresh data
   * store. The merge pipeline then sees the edited entities as ordinary source,
   * so unit-aware federation, GlobalId reconciliation and id offsetting are
   * unaffected. Models without edits pass through untouched (no export/parse cost).
   */
  private async bakeMutatedModels(): Promise<MergeModelInput[]> {
    const baked: MergeModelInput[] = [];
    let parser: IfcParser | null = null;
    for (const model of this.models) {
      if (!viewHasMutations(model.mutationView)) {
        baked.push(model);
        continue;
      }
      const sourceSchema = (model.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
      // Export in the SOURCE schema so no schema conversion happens here — the
      // merge loop still converts to the requested target schema per entity.
      const exported = new StepExporter(model.dataStore, model.mutationView).export({
        schema: sourceSchema,
        applyMutations: true,
        includeGeometry: true,
        includeQuantities: true,
      });
      parser = parser ?? new IfcParser();
      // slice() yields an exact-length ArrayBuffer-backed copy for the parser.
      const reparsed = await parser.parseColumnar(exported.content.slice().buffer, {
        disableWorkerScan: true,
      });
      baked.push({
        id: model.id,
        name: model.name,
        dataStore: reparsed,
        // Keep the caller's explicit unit scale (else the original store's) so
        // unit-aware federation is unaffected by the bake round-trip.
        lengthUnitScale: model.lengthUnitScale ?? model.dataStore.lengthUnitScale,
      });
    }
    return baked;
  }

  /**
   * Assemble the result stats, including any federation conformance warnings.
   */
  private buildStats(
    totalEntityCount: number,
    fileSize: number,
    federatedModelCount: number,
    normalizedModelCount: number,
    normalizeWarnings: Set<string>,
  ): MergeExportResult['stats'] {
    const warnings: string[] = [];
    if (federatedModelCount > 0) {
      warnings.push(
        `${federatedModelCount} model(s) had a length unit differing from the first model and were ` +
        `federated as separate IfcProject roots to keep their geometry correctly scaled. The output ` +
        `therefore contains ${federatedModelCount + 1} IfcProject instances, which intentionally relaxes ` +
        `the IfcSingleProjectInstance rule (SIZEOF(IfcProject) <= 1). Some single-project viewers may ` +
        `only show the first project. Pass unitReconciliation:'normalize' to rescale them into one ` +
        `single-unit project, or 'assume-shared' when units are already normalised.`,
      );
    }
    warnings.push(...normalizeWarnings);
    return { modelCount: this.models.length, totalEntityCount, fileSize, federatedModelCount, normalizedModelCount, warnings };
  }

  /**
   * Record advisories for a model being normalized. The rescaler derives its
   * length-attribute map from the IFC4 schema registry, so it may not cover
   * length attributes introduced by newer schemas (IFC4X3 alignment / linear
   * referencing), and it deliberately leaves georeferencing untouched.
   */
  private collectNormalizeCaveats(model: MergeModelInput, warnings: Set<string>): void {
    const schema = (model.dataStore.schemaVersion ?? '').toUpperCase();
    if (NORMALIZE_UNCOVERED_SCHEMAS.has(schema)) {
      warnings.add(
        `Model "${model.name}" (${schema}) was normalized using the IFC4 length-attribute schema; ` +
        `length values on ${schema}-specific entities (e.g. alignment / linear-referencing segment ` +
        `lengths and radii) may not have been rescaled. Verify infrastructure geometry.`,
      );
    }
    if (this.findEntitiesByType(model.dataStore, 'IFCMAPCONVERSION').length > 0) {
      warnings.add(
        `Model "${model.name}" carries georeferencing (IfcMapConversion), which normalize leaves ` +
        `untouched. If the model was georeferenced in its own unit, review the merged coordinate ` +
        `operation.`,
      );
    }
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
  private buildMergeSetup(options: MergeExportOptions, models: MergeModelInput[]): MergeSetup {
    // Determine ID offsets. Span the COMPLETE entity set (incl. deferred
    // property atoms) so the next model's offset clears every id this model
    // will emit — otherwise a deferred atom at a high id collides. Computed over
    // the (possibly baked) model list so mutation-created entities are covered.
    let nextAvailableId = 1;
    const modelOffsets = new Map<string, number>();
    for (const model of models) {
      modelOffsets.set(model.id, nextAvailableId - 1); // start at nextAvailableId
      nextAvailableId += getMaxExpressId(getCompleteEntityIndex(model.dataStore));
    }

    const firstModel = models[0];
    const primaryScale = this.resolveUnitScale(firstModel);
    return {
      modelOffsets,
      firstModelOffset: modelOffsets.get(firstModel.id)!,
      firstModelInfraMap: this.findInfrastructureEntities(firstModel.dataStore),
      firstProjectIds: this.findEntitiesByType(firstModel.dataStore, 'IFCPROJECT'),
      spatialLookup: this.buildSpatialLookup(firstModel.dataStore),
      primaryScale,
      primaryAreaScale: this.resolveDerivedUnitScale(firstModel.dataStore, 'AREAUNIT', primaryScale, 2),
      primaryVolumeScale: this.resolveDerivedUnitScale(firstModel.dataStore, 'VOLUMEUNIT', primaryScale, 3),
      assumeShared: options.unitReconciliation === 'assume-shared',
      normalize: options.unitReconciliation === 'normalize',
      mergeSites: options.mergeSites,
      mergeBuildings: options.mergeBuildings,
      mergeStoreys: options.mergeStoreys,
    };
  }

  /**
   * Decide how one model folds into the merge from its length unit and the
   * reconciliation mode.
   *
   * - The primary model, `assume-shared`, and any model that already shares the
   *   primary unit are unified with no rescale.
   * - Under `normalize`, a differing-unit model is unified *and* rescaled: every
   *   length-valued datum is multiplied by `primaryScale`-relative factor so its
   *   geometry stays correct under the single shared unit.
   * - Otherwise (`auto`) a differing-unit model is federated (kept as its own
   *   project + units), leaving its raw coordinates untouched.
   *
   * Area/volume reconciliation is gated on the length unit differing: a model that
   * shares the primary's length unit is treated as fully compatible (factors 1).
   * A model that pairs a matching length unit with a *divergent* area/volume unit
   * (a non-conformant combination no mainstream exporter emits) is not rescaled.
   */
  private resolveModelMode(model: MergeModelInput, isFirstModel: boolean, setup: MergeSetup): ModelMode {
    const modelScale = this.resolveUnitScale(model);
    if (isFirstModel || setup.assumeShared || this.unitsCompatible(modelScale, setup.primaryScale)) {
      return { compatible: true, lengthFactor: 1, areaFactor: 1, volumeFactor: 1, effectiveScale: modelScale, normalized: false };
    }
    if (setup.normalize) {
      // Each dimension is converted by the ratio of its own declared unit, not by
      // powers of the length factor — IFC declares area/volume units independently
      // (Revit: millimetre lengths but square-/cubic-metre areas/volumes).
      const modelArea = this.resolveDerivedUnitScale(model.dataStore, 'AREAUNIT', modelScale, 2);
      const modelVolume = this.resolveDerivedUnitScale(model.dataStore, 'VOLUMEUNIT', modelScale, 3);
      return {
        compatible: true,
        lengthFactor: computeNormalizeFactor(modelScale, setup.primaryScale),
        areaFactor: computeNormalizeFactor(modelArea, setup.primaryAreaScale),
        volumeFactor: computeNormalizeFactor(modelVolume, setup.primaryVolumeScale),
        effectiveScale: setup.primaryScale,
        normalized: true,
      };
    }
    // auto: federate the differing-unit model, coordinates untouched.
    return { compatible: false, lengthFactor: 1, areaFactor: 1, volumeFactor: 1, effectiveScale: modelScale, normalized: false };
  }

  /**
   * Resolve a model's declared AREAUNIT / VOLUMEUNIT scale (SI m² / m³ per unit)
   * by walking IfcProject → IfcUnitAssignment. Falls back to the length-derived
   * unit (`lengthScale ** power`) when the model declares no explicit area/volume
   * unit — the IFC default. A prefixed SI area/volume unit (rare) applies the
   * prefix once (buildingSMART / IfcOpenShell convention).
   */
  private resolveDerivedUnitScale(
    dataStore: IfcDataStore,
    wantType: 'AREAUNIT' | 'VOLUMEUNIT',
    lengthScale: number,
    power: number,
  ): number {
    const fallback = Math.pow(lengthScale, power);
    const projectIds = this.findEntitiesByType(dataStore, 'IFCPROJECT');
    if (projectIds.length === 0) return fallback;

    // IfcProject.UnitsInContext = attr 8 → IfcUnitAssignment.
    const unitsAttr = this.extractStepAttribute(projectIds[0], dataStore, 8);
    const assignMatch = unitsAttr?.match(/^#(\d+)$/);
    if (!assignMatch) return fallback;

    // IfcUnitAssignment.Units = attr 0 (a list of unit refs).
    const listAttr = this.extractStepAttribute(parseInt(assignMatch[1], 10), dataStore, 0);
    if (!listAttr) return fallback;

    for (const m of listAttr.matchAll(/#(\d+)/g)) {
      const uid = parseInt(m[1], 10);
      const uref = dataStore.entityIndex.byId.get(uid);
      const utype = (uref?.type ?? '').toUpperCase();

      if (utype === 'IFCSIUNIT') {
        // IfcSIUnit: [1] UnitType, [2] Prefix, [3] Name.
        if (this.normalizeEnum(this.extractStepAttribute(uid, dataStore, 1)) !== wantType) continue;
        const prefixRaw = this.extractStepAttribute(uid, dataStore, 2);
        if (!prefixRaw || prefixRaw === '$' || prefixRaw === '*') return 1.0; // square/cubic metre
        const mult = SI_PREFIX_MULTIPLIERS[this.normalizeEnum(prefixRaw)];
        return mult !== undefined ? mult : 1.0;
      }

      if (utype === 'IFCCONVERSIONBASEDUNIT') {
        // IfcConversionBasedUnit: [1] UnitType, [2] Name, [3] ConversionFactor.
        if (this.normalizeEnum(this.extractStepAttribute(uid, dataStore, 1)) !== wantType) continue;
        const convMatch = this.extractStepAttribute(uid, dataStore, 3)?.match(/^#(\d+)$/);
        if (convMatch) {
          // IfcMeasureWithUnit.ValueComponent = attr 0 (e.g. IFCAREAMEASURE(0.0929)).
          const num = this.parseMeasureNumber(this.extractStepAttribute(parseInt(convMatch[1], 10), dataStore, 0));
          if (num !== undefined && num > 0) return num;
        }
        return fallback;
      }
    }
    return fallback;
  }

  /** Uppercase an enum token, stripping the STEP `.ENUM.` dots. `''` for nullish. */
  private normalizeEnum(raw: string | null): string {
    return (raw ?? '').replace(/\./g, '').trim().toUpperCase();
  }

  /** Extract the number from a bare real or a typed measure token (`IFCAREAMEASURE(0.09)`). */
  private parseMeasureNumber(raw: string | null): number | undefined {
    if (!raw) return undefined;
    const typed = raw.match(/\(([^)]*)\)\s*$/);
    const n = Number((typed ? typed[1] : raw).trim());
    return Number.isFinite(n) ? n : undefined;
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
   * Compatible models (same unit, `assume-shared`, or `normalize`d into the
   * primary unit) are unified into the primary project: their IfcProject, shared
   * infrastructure, and matching spatial structure are deduplicated, and a rooted
   * entity repeating an already-emitted GlobalId is unified to that one instance.
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
    lengthFactor: number,
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
      // Under normalize, this model's raw elevations are in its own unit, so the
      // elevation match is done in the primary unit (rawElevation * lengthFactor).
      this.unifySpatialEntities(model.dataStore, setup.spatialLookup, setup.firstModelOffset, lengthFactor, sharedRemap, skipEntityIds, setup);

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
    mode: ModelMode,
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

    // Normalize units: rescale every length/area/volume-valued datum into the
    // primary unit. Done on the SOURCE-schema text (entityRef.type), before any
    // schema conversion, so the schema-derived attribute indices line up. Touches
    // only numeric literals, so id remaps and the GlobalId re-stamp above are safe.
    if (mode.lengthFactor !== 1 || mode.areaFactor !== 1 || mode.volumeFactor !== 1) {
      finalText = rescaleEntityLengths(finalText, entityRef.type.toUpperCase(), mode.lengthFactor, mode.areaFactor, mode.volumeFactor);
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
        guidToFinalId.set(emittedGuid, { finalId: localId + offset, scale: mode.effectiveScale });
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
   * Matching strategy per container type is driven by
   * {@link MergeExportOptions.mergeSites} / `mergeBuildings` / `mergeStoreys`
   * (all optional; omitted keeps the pre-existing combined heuristic):
   * - Sites/Buildings: `'single'` (ignore name, unify iff exactly one in each
   *   model), `'by-name'` (name only, no fallback), or omitted — name first,
   *   else single-instance fallback.
   * - Storeys: `'by-name'`, `'by-elevation'` (tolerance ±0.5 model units), or
   *   `'by-name-then-elevation'` (default, also the omitted behavior).
   */
  private unifySpatialEntities(
    dataStore: IfcDataStore,
    lookup: SpatialLookup,
    firstModelOffset: number,
    elevationFactor: number,
    sharedRemap: Map<number, number>,
    skipEntityIds: Set<number>,
    mergeModes: Pick<MergeSetup, 'mergeSites' | 'mergeBuildings' | 'mergeStoreys'>,
  ): void {
    // Unify IfcSite. matchedFirstSites guards against two of this model's
    // sites (e.g. duplicate/identically-named) both matching the same
    // first-model target — only the first claims it, the second is kept as
    // its own root instead of silently losing its spatial sub-tree.
    const sites = this.findEntitiesByType(dataStore, 'IFCSITE');
    const matchedFirstSites = new Set<number>();
    for (const id of sites) {
      const match = this.matchRootContainer(
        id, dataStore, mergeModes.mergeSites, sites.length,
        lookup.sitesByName, lookup.siteIds, matchedFirstSites,
      );
      if (match !== undefined) {
        matchedFirstSites.add(match);
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuilding — same already-matched guard as sites.
    const buildings = this.findEntitiesByType(dataStore, 'IFCBUILDING');
    const matchedFirstBuildings = new Set<number>();
    for (const id of buildings) {
      const match = this.matchRootContainer(
        id, dataStore, mergeModes.mergeBuildings, buildings.length,
        lookup.buildingsByName, lookup.buildingIds, matchedFirstBuildings,
      );
      if (match !== undefined) {
        matchedFirstBuildings.add(match);
        sharedRemap.set(id, match + firstModelOffset);
        skipEntityIds.add(id);
      }
    }

    // Unify IfcBuildingStorey — mode-driven name/elevation matching
    const storeyMode = mergeModes.mergeStoreys ?? 'by-name-then-elevation';
    const matchedFirstStoreys = new Set<number>();
    for (const id of this.findEntitiesByType(dataStore, 'IFCBUILDINGSTOREY')) {
      const name = this.extractEntityName(id, dataStore);
      let match: number | undefined;

      // Name match (skipped entirely under 'by-elevation')
      if (storeyMode !== 'by-elevation' && name) {
        const candidate = lookup.storeysByName.get(name.toLowerCase());
        if (candidate !== undefined && !matchedFirstStoreys.has(candidate)) {
          match = candidate;
        }
      }

      // Elevation match (skipped entirely under 'by-name'). The candidate's raw
      // elevation is in this model's unit; scale it into the primary unit so the
      // comparison (and the ±0.5 m tolerance) is unit-consistent under normalize
      // (factor 1 otherwise).
      if (match === undefined && storeyMode !== 'by-name') {
        const rawElevation = this.extractStoreyElevation(id, dataStore);
        if (rawElevation !== undefined) {
          const elevation = rawElevation * elevationFactor;
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
   * Match one IfcSite/IfcBuilding instance against the first model's
   * equivalents, per {@link mergeMode}:
   * - `'single'`: ignore name — unify iff both models contribute exactly one.
   * - `'by-name'`: name match only, no single-instance fallback.
   * - omitted: name match, else single-instance fallback (pre-existing heuristic).
   *
   * `matchedFirst` excludes first-model targets already claimed by an earlier
   * entity in this same model's loop — without it, two of this model's sites
   * (or buildings) sharing a name/being the sole instance would both resolve
   * to the same target, and the second would be dropped (skipped + remapped)
   * rather than kept as its own root.
   */
  private matchRootContainer(
    id: number,
    dataStore: IfcDataStore,
    mergeMode: 'single' | 'by-name' | undefined,
    countInThisModel: number,
    firstModelByName: Map<string, number>,
    firstModelIds: number[],
    matchedFirst: Set<number>,
  ): number | undefined {
    const bySingle = () => {
      if (countInThisModel !== 1 || firstModelIds.length !== 1) return undefined;
      const candidate = firstModelIds[0];
      return matchedFirst.has(candidate) ? undefined : candidate;
    };
    const byName = () => {
      const name = this.extractEntityName(id, dataStore);
      if (!name) return undefined;
      const candidate = firstModelByName.get(name.toLowerCase());
      return candidate !== undefined && !matchedFirst.has(candidate) ? candidate : undefined;
    };

    if (mergeMode === 'single') return bySingle();
    if (mergeMode === 'by-name') return byName();
    return byName() ?? bySingle();
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

