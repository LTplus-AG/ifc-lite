/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC STEP file exporter
 *
 * Exports IFC data store to ISO 10303-21 STEP format.
 * Supports applying property and root attribute mutations before export.
 */

import type { IfcDataStore, IfcAttributeValue, IfcSourceHeader, IfcSourceBytes } from '@ifc-lite/parser';
import {
  asSourceBytes,
  EntityExtractor,
  extractQuantitiesOnDemand,
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
import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import {
  collectReferencedEntityIds,
  getVisibleEntityIds,
  collectStyleEntities,
  filterHiddenRefsFromRelationshipLine,
} from './reference-collector.js';
import { convertStepLine, needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { retypeStepLine, retypeArgTokens } from './retype.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
import {
  createModificationLedger,
  recordSourceLineDelivery,
  type ModificationLedger,
  type SourceLineDelivery,
} from './delta-modification-ledger.js';
import { nominateDeliveredInPlaceEdits, type InPlaceNominees } from './in-place-nomination.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import { authoredEntityRefs, getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import {
  HAS_PROPERTY_SETS_SLOT,
  isTypeClass,
  resolveTypeOwnedPsetIds,
  rewriteTypeOwnedPsetLine,
  typeOwnedPsetRewriteWarning,
} from './type-owned-psets.js';
import {
  escapeStepString,
  toStepReal,
  quantityTypeToIfcType,
  serializeAttributeValue,
  serializeStepValue,
  tokenIsRealLiteral,
} from './step-serialization.js';
import { splitTopLevelArgs } from './step-argument-parser.js';
import { assembleStepBytes } from './step-file-assembly.js';
import { getRealTypedSlots, serializeEntityArgs, serializeAttributeSlot, isTypedMarker } from './attribute-real-slots.js';
import {
  getEnumTypedSlots,
  getStringTypedSlots,
  serializeEnumToken,
  serializeStringSlot,
} from './attribute-slot-types.js';
import { serializeQualifiedSelectSlot } from './select-qualification.js';
import { serializeNominalValue } from './declared-property-type.js';

/**
 * UTF-8 decode of `[start, end)` of the source, accepting either the raw bytes
 * or the {@link IfcSourceBytes} accessor (#2183). Replaces the direct
 * `safeUtf8Decode(source, …)` calls this file used to make: `decodeUtf8` is
 * SAB-safe in exactly the same way, and routing through the accessor is what
 * lets `IfcDataStore.source` change shape without touching these four reads.
 */
function decodeRange(src: Uint8Array | IfcSourceBytes, start: number, end: number): string {
  return asSourceBytes(src).decodeUtf8(start, end);
}

/** `OwnerHistory` is slot 1 on every `IfcRoot` subtype, all schemas. */
const OWNER_HISTORY_SLOT = 1;

/**
 * The store the extractor THIS class installed on a view currently reads
 * (#2487). The extractor is installed once per view and closes over this box
 * rather than over a store directly, so a later export of the same view against
 * a different store re-points it instead of answering from the first file.
 *
 * A box, and not a `WeakSet` of views, because ownership has to reflect the
 * CURRENT state and not the historical fact that an export once installed
 * something. `setQuantityExtractor` is public: a caller may install its own
 * afterwards, and a marker saying "the exporter owns this view" would then keep
 * overwriting a caller-supplied base forever. With a box, the second export
 * writes to a box nothing reads any more and never calls the setter again, so
 * the caller's extractor stands. Weak, so it never keeps a session alive.
 */
const exporterQuantityBase = new WeakMap<MutablePropertyView, { store: IfcDataStore }>();

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
  'Cannot create IfcMapConversion: no IfcGeometricRepresentationContext is available to reference as SourceCRS. The IfcProjectedCRS is unaffected.';

/**
 * Message for the refusal `export()` reports when a map conversion is
 * requested but there is no IfcProjectedCRS to attach it to — none was
 * requested and none exists in the file — distinct from
 * {@link MAP_CONVERSION_WITHOUT_CONTEXT_WARNING}, which is worded for the
 * case where an IfcProjectedCRS exists (or was written) but no context is
 * available to reference.
 */
const MAP_CONVERSION_WITHOUT_CRS_WARNING =
  'Cannot create IfcMapConversion: no IfcProjectedCRS was requested and none exists in the file to reference as TargetCRS. Nothing was written.';

/**
 * What {@link StepExporter.applySourceLineMutations} produced: the rewritten
 * line, plus which edit kinds that rewrite actually delivered. The delivery
 * half is {@link SourceLineDelivery} rather than three loose booleans so that
 * the pipeline and the ledger cannot disagree about what a source line carries
 * — an added kind has one place to be added.
 */
type SourceLineMutations = SourceLineDelivery & { text: string };

/**
 * The state one `export()` call shares across its seven phases.
 *
 * Introduced by step 1 of #2475: `export()` is ~1267 lines and the phases a
 * split would separate are held together by ~30 local bindings, most of which
 * are read in three or more phases. Naming that set once — as an interface
 * with a single construction site at the top of `export()` — is what lets a
 * later phase extraction take one parameter instead of fifteen.
 *
 * Two properties of this object are load-bearing and must survive every later
 * move:
 *
 * 1. **The predicates are members, not duplicated expressions.** Six of them
 *    (`isOverlayCreated`, `isReadableSourceRef`, `isGeometryExcluded`,
 *    `hasEmittableHostBytes`, `willBeEmitted`,
 *    `isExcludedFromRelationshipRefs`) exist precisely so two phases cannot
 *    disagree about a gate — see the comments at their construction sites for
 *    the corrupt files the earlier, per-phase versions let through (#2491,
 *    #2414, #2398, #2637). A phase that reimplements one of these instead of
 *    reading it off the pass reintroduces exactly that class of defect.
 * 2. **`allowedEntityIds` and `hiddenProductIds` are mutable, and the
 *    predicates close over the pass rather than over a snapshot.** The
 *    visible-only closure walk assigns both AFTER construction, and
 *    `isExcludedFromRelationshipRefs` is handed to that walk while they are
 *    still null. Reading them through `pass` keeps the walk's bridge decision
 *    and the output-line filtering on one answer, which is the invariant the
 *    #2637 regression broke.
 *
 * Deliberately NOT on the pass, and why: `mayNameExcludedRefs` and
 * `overlayNewEntityCount` are eagerly-computed values whose value is only
 * defined after work that runs past this construction site, so hoisting them
 * would change what they compute rather than where they are named;
 * `generatedTypeOwnedPsetIds` is read in one phase only.
 */
interface ExportPass {
  /** Output accumulator: every DATA-section line this export will write. */
  readonly entities: string[];
  /** Lines contributed by entities that have no source record. */
  newEntityCount: number;

  // ---- resolved options / schema ----
  readonly schema: IfcSchemaVersion;
  readonly sourceSchema: IfcSchemaVersion;
  readonly converting: boolean;
  readonly sourceHeader: IfcSourceHeader | undefined;
  readonly schemaToken: string;
  readonly overlayActive: boolean;

  // ---- indexes and ledgers ----
  readonly effective: EffectiveEntityIndex;
  readonly modifications: ModificationLedger;
  /** Widened from the imported `InPlaceNominees` (whose sets are readonly)
   *  because the collection passes below add to them. */
  readonly inPlaceNominees: { attribute: Set<number>; georeferencing: Set<number> };

  // ---- visible-only closure results (assigned after construction) ----
  allowedEntityIds: Set<number> | null;
  hiddenProductIds: ReadonlySet<number> | null;

  // ---- the collection passes' output ----
  readonly modifiedEntities: Set<number>;
  readonly modifiedAttributes: Map<number, Map<string, string>>;
  readonly newPropertySets: Array<{ entityId: number; psets: PropertySet[] }>;
  readonly newQuantitySets: Array<{ entityId: number; qsets: QuantitySet[] }>;
  readonly typeOwnedPsetNamesByEntity: Map<number, Set<string>>;
  readonly typeOwnedPsetIdsByEntity: Map<number, number[]>;
  readonly rewrittenEntityIds: Set<number>;
  readonly rewrittenEntityLines: Map<number, string>;
  readonly overlayTypeOwnedPsets: Map<number, IfcAttributeValue>;
  readonly skipPropertySetIds: Set<number>;
  readonly skipRelationshipIds: Set<number>;
  readonly newGeorefLines: string[];
  readonly warnings: string[];

  // ---- the shared predicates (see item 1 above) ----
  readonly buildHeader: (modifications: number) => string;
  readonly isOverlayCreated: (entityId: number) => boolean;
  readonly isReadableSourceRef: ReturnType<typeof createSourceRefReader>;
  readonly isGeometryExcluded: (entityId: number, recordType: string) => boolean;
  readonly hasEmittableHostBytes: (entityId: number) => boolean;
  readonly willBeEmitted: (entityId: number) => boolean;
  readonly isExcludedFromRelationshipRefs: (id: number) => boolean;
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
  /**
   * "Can this record's line actually be read out of this store's source?"
   * (`source-ref-bounds.ts`, #2491). Built once — `dataStore` is assigned in
   * the constructor and never reassigned — so the gates outside `export`'s
   * closure share one predicate instead of rebuilding it per call.
   */
  private isReadableSourceRef: ReturnType<typeof createSourceRefReader>;

  constructor(dataStore: IfcDataStore, mutationView?: MutablePropertyView) {
    this.dataStore = dataStore;
    this.isReadableSourceRef = createSourceRefReader(dataStore.source);
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
      ?? (this.dataStore.source.byteLength > 0
        ? parseSourceHeader(this.dataStore.source)
        : undefined);

    // Preserve the exact FILE_SCHEMA identifier (e.g. IFC4X3_ADD2) only when we
    // are NOT converting schemas; conversion must emit the coarse target token.
    const schemaToken: string =
      !converting && sourceHeader?.schemaIdentifiers?.[0]
        ? sourceHeader.schemaIdentifiers[0]
        : schema;

    // The one construction site for the state this export shares across its
    // seven phases. See `ExportPass` above for what belongs here, what
    // deliberately does not, and why every predicate reads `pass` rather than
    // a value captured at construction time.
    const pass: ExportPass = {
      entities: [],
      newEntityCount: 0,
      schema,
      sourceSchema,
      converting,
      sourceHeader,
      schemaToken,
      overlayActive: !!this.mutationView && (options.applyMutations !== false),

      // Built once entity counts are known, so the provenance item can report the
      // actual modification count. See the two call sites (empty delta + final).
      buildHeader: (modifications: number): string => {
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
      },

      // The one authority for exists / class / deleted, overlay first and source
      // buffer second. Every pass below asks this instead of `this.dataStore`,
      // which answers only for the file as parsed (#2012).
      effective: getEffectiveEntityIndex(
        this.dataStore,
        this.mutationView,
        options.applyMutations !== false,
      ),

      // Does this id belong to an entity the OVERLAY created (`createEntity` /
      // `store.addEntity`) rather than to a record in the source buffer? Such an
      // entity has no source bytes, so the source-iteration pass below never sees
      // it and the new-entities pass at the end owns its line entirely (#2006).
      isOverlayCreated: (entityId: number): boolean => pass.effective.isOverlayCreated(entityId),

      // Does this record describe a line this export can actually READ out of the
      // source? One predicate for every byte-range gate below, so they cannot
      // disagree — see `source-ref-bounds.ts` for the corrupt file the weaker
      // "is there a source / does the ref claim bytes" pair let through (#2491).
      isReadableSourceRef: createSourceRefReader(this.dataStore.source),

      // Build visible-only closure if requested. Classification, the closure walk
      // and the style pass all run over the EFFECTIVE index: an overlay-created
      // product becomes a root by the same type rules as a parsed one, the walk
      // follows its authored references into the geometry it alone owns, and a
      // tombstoned entity is simply not there. Run over the source buffer, a
      // created wall could never be a root and nothing referenced it, so
      // `visibleOnly` wrote a file without it and said nothing (#2012).
      //
      // Computed here, ahead of the modification-count passes below, because
      // `hasEmittableHostBytes` needs it: a source-backed host EXCLUDED by
      // `visibleOnly` never gets its line written by the source-iteration pass
      // either, so counting it as "modified" would make the header claim a
      // change the DATA section does not contain (CodeRabbit finding on #2414).
      allowedEntityIds: null,

      // Populated alongside `allowedEntityIds` below. `getVisibleEntityIds`
      // excludes a hidden PRODUCT's own line from the closure, but `IFCREL*` is
      // an unconditional root a few lines down and its bytes are copied verbatim
      // by the source-iteration pass — nothing there filters a `#N` the closure
      // just excluded out of the relationship's own attribute list. Kept so the
      // source-iteration and overlay new-entity passes can run
      // `filterHiddenRefsFromRelationshipLine` against the SAME exclusion set
      // `collectReferencedEntityIds` used, rather than a second, possibly
      // divergent notion of "hidden" (#2398).
      hiddenProductIds: null,

      // A relationship can name an excluded entity two ways that have nothing
      // to do with each other: a `visibleOnly` hidden PRODUCT (`hiddenProductIds`,
      // below), and a TOMBSTONED one — `editor.removeEntity` on a related object
      // named by a relationship the deletion sweep below does not reach (that
      // sweep only withholds an `IfcRelDefinesByProperties` when EVERY related
      // object is gone, and only for that one relationship class). Left alone, a
      // relationship still naming a deleted entity ships the identical `#N` with
      // no `#N=` line, on a path with no `visibleOnly` involved at all (#2398).
      // `effective.isDeleted` answers for every id, not just a precomputed set,
      // so this predicate covers both sources without a second exclusion set.
      //
      // Declared here, ahead of the closure walk below, and passed into
      // `collectReferencedEntityIds` as its `isRefExcluded` — the walk's bridge
      // decision (whether an `IFCREL*` root may reach what it names) and the
      // OUTPUT-line filtering further down now read the SAME predicate, rather
      // than the walk inventing its own `!entityIndex.has` proxy for "deleted"
      // that could disagree with this one on an id that never existed in the
      // file at all (maintainer-found regression on #2637: such an id blocked
      // the bridge but did not stop the relationship's own line from shipping,
      // dropping a VISIBLE sibling's pset while adding a fresh dangling ref).
      // A closure over the `let hiddenProductIds` above, not a value snapshot —
      // correct because nothing reads it before `hiddenProductIds` is assigned
      // just below.
      isExcludedFromRelationshipRefs: (id: number): boolean =>
        (pass.hiddenProductIds !== null && pass.hiddenProductIds.has(id))
        || pass.effective.isDeleted(id),

      // Will THIS entity's own line ever land in the file? The same byte-range
      // test `willBeEmitted` uses (defined further below) and the source-
      // iteration pass's own skip at `entityRef.byteLength === 0` — a source
      // entity with no bytes (a point-cloud / GLB "entity" from
      // `createSyntheticDataStore`, not an overlay-created one) never gets a
      // defining line written, source-iteration or otherwise, so a pset/attribute
      // edit against it must not count as a modification either: the header
      // would describe a change the file does not contain (out-of-scope finding
      // in #2398). Also excludes a source-backed host the visible-only closure
      // above drops — same reasoning, different reason the line never lands.
      //
      // And, like `willBeEmitted` below, excludes a geometry-classified SOURCE
      // host under `includeGeometry: false`: the source-iteration pass's own
      // `isGeometryEntity` skip (further below) drops that line too, so this
      // predicate must agree or a geometry entity's attribute edit inflates the
      // count over an omitted line (CodeRabbit finding on #2414). Guarded by
      // `!deltaOnly` for the same reason `willBeEmitted` is: under `deltaOnly`
      // the source-iteration pass — and its geometry skip — never runs at all,
      // so a source entity's line is assumed to already exist in the file being
      // patched, geometry or not.
      isGeometryExcluded: (entityId: number, recordType: string): boolean =>
        options.includeGeometry === false
        && this.isGeometryEntity(pass.effective.effectiveType(entityId, recordType)),
      hasEmittableHostBytes: (entityId: number): boolean => {
        if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(entityId)) return false;
        const ref = pass.effective.get(entityId);
        // The ref must be READABLE, not merely non-empty: a range this source
        // cannot address decodes to the empty string, which used to be pushed
        // into the file as a blank line while everything generated FOR the host
        // still named it (#2491).
        if (!ref || !pass.isReadableSourceRef(ref)) return false;
        if (options.deltaOnly !== true && pass.isGeometryExcluded(entityId, ref.type)) return false;
        return true;
      },

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
      willBeEmitted: (entityId: number): boolean => {
        if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(entityId)) return false;
        // Undefined for a tombstoned id and for one neither the file nor the
        // session ever had — a stale mutation must not conjure a relation either.
        const ref = pass.effective.get(entityId);
        if (!ref) return false;
        // An overlay-created record carries the placeholder byte range and is
        // written by the new-entities pass; a source record needs real bytes.
        if (pass.effective.isOverlayCreated(entityId)) {
          // The overlay new-entities pass applies its OWN `isGeometryEntity`
          // filter unconditionally — deltaOnly or not (see the comment at that
          // loop, further below) — so this branch mirrors it without the
          // deltaOnly carve-out the source branch gets.
          return !pass.isGeometryExcluded(entityId, ref.type);
        }
        // Same readability test as `hasEmittableHostBytes`, and for the reason
        // that predicate names: a ref this source cannot address is not a line
        // this export can write, so nothing may be generated naming it (#2491).
        if (!pass.isReadableSourceRef(ref)) return false;
        // Mirrors `hasEmittableHostBytes`: under `deltaOnly` the source-
        // iteration pass — and its geometry skip — never runs, so a source
        // entity's line is assumed to already exist in the file being patched.
        if (options.deltaOnly === true) return true;
        return !pass.isGeometryExcluded(entityId, ref.type);
      },

      // Under `deltaOnly` a nomination only becomes a count once some pass has
      // actually written content that delivers THAT KIND of edit for the host —
      // see `delta-modification-ledger.ts` for why the two are not the same event
      // in that mode, and why the pair is (entity, kind) rather than the entity
      // (#2462).
      modifications: createModificationLedger(options.deltaOnly === true),

      /**
       * Hosts whose in-place named-attribute edits a FULL export may count, per
       * kind. Filled by the collection passes below and read by the two passes
       * that write a rewritten source line — see `in-place-nomination.ts` for why
       * the nomination waits for the rewrite in this mode and not under
       * `deltaOnly` (#2483).
       */
      inPlaceNominees: {
        attribute: new Set<number>(),
        georeferencing: new Set<number>(),
      },

      // Collect entities that need to be modified or created
      modifiedEntities: new Set<number>(),
      modifiedAttributes: new Map<number, Map<string, string>>(),
      newPropertySets: [],
      newQuantitySets: [],
      typeOwnedPsetNamesByEntity: new Map<number, Set<string>>(),
      typeOwnedPsetIdsByEntity: new Map<number, number[]>(),
      rewrittenEntityIds: new Set<number>(),
      rewrittenEntityLines: new Map<number, string>(),
      /** HasPropertySets slot value for an OVERLAY-CREATED type object, applied
       *  by the new-entities pass (there is no source line to rewrite). */
      overlayTypeOwnedPsets: new Map<number, IfcAttributeValue>(),

      // Track property set IDs and relationship IDs to skip
      skipPropertySetIds: new Set<number>(),
      skipRelationshipIds: new Set<number>(),

      // Written by the georeferencing pass and read again by the final
      // assembly, which is why they are pass state and not phase locals.
      newGeorefLines: [],
      warnings: [],
    };

    if (options.visibleOnly && this.dataStore.source) {
      const visible = getVisibleEntityIds(
        this.dataStore,
        options.hiddenEntityIds ?? new Set(),
        options.isolatedEntityIds ?? null,
        pass.effective,
      );
      pass.hiddenProductIds = visible.hiddenProductIds;
      pass.allowedEntityIds = collectReferencedEntityIds(
        visible.roots,
        this.dataStore.source,
        pass.effective,
        visible.hiddenProductIds,
        pass.isExcludedFromRelationshipRefs,
      );
      // Second pass: collect IFCSTYLEDITEM entities that reference included
      // geometry. Styled items reference geometry items but nothing references
      // them back, so the forward closure misses them.
      collectStyleEntities(
        pass.allowedEntityIds,
        this.dataStore.source,
        { byId: pass.effective, byType: pass.effective.byType },
      );
    }

    // Duplicates `pass.overlayActive` as the same expression rather than
    // reading it, because this value also folds in `hiddenProductIds`, which
    // the closure walk above only just assigned.
    const mayNameExcludedRefs = (pass.hiddenProductIds !== null && pass.hiddenProductIds.size > 0)
      || (!!this.mutationView && options.applyMutations !== false);

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
        pass.modifiedEntities.add(entityId);
        let target = pass.modifiedAttributes.get(entityId);
        if (!target) {
          target = new Map();
          pass.modifiedAttributes.set(entityId, target);
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

        const isQuantity = mutation.type === 'CREATE_QUANTITY' || mutation.type === 'UPDATE_QUANTITY'
          || mutation.type === 'DELETE_QUANTITY' || mutation.type === 'DELETE_QUANTITY_SET';
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
        if (related.length > 0 && related.every((id) => pass.effective.isDeleted(id))) {
          pass.skipRelationshipIds.add(relId);
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
        if (pass.effective.isDeleted(entityId)) continue;
        pass.modifiedEntities.add(entityId);
        // Same rule as the attribute loop below: an overlay-CREATED entity is
        // emitted once, by the new-entities pass, and already counted in
        // `newEntityCount` — as are the pset entities this loop goes on to
        // generate. Only the COUNT is guarded; the entity still records its
        // pset edits and still emits them.
        //
        // A NOMINATION, in both modes, never a count on its own: this site sees
        // a pset NAME the session touched, not whether that name resolves to
        // anything. `deletePropertySet(id, 'AName')` on a host that owns no such
        // set reaches here and changes nothing at all, and used to put "1
        // modification" in the header of a byte-identical file (#2474). What
        // settles it is the generator's `recordEmitted` and the skip branches'
        // `recordWithheld` below.
        if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
          pass.modifications.nominate(entityId, 'property-set');
        }

        // Get the FULL mutated property sets for this entity (merged base + mutations)
        const allPsets = this.mutationView.getForEntity(entityId);
        const relevantPsets = allPsets.filter((pset: PropertySet) => psetNames.has(pset.name));
        const relDefinedPsetNames = new Set<string>();

        if (relevantPsets.length > 0) {
          pass.newPropertySets.push({ entityId, psets: relevantPsets });
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
              pass.skipRelationshipIds.add(relId);
              pass.skipPropertySetIds.add(relatedPsetId);
              // Also skip the individual properties in this pset
              const propIds = this.getPropertyIdsInSet(relatedPsetId);
              for (const propId of propIds) {
                pass.skipPropertySetIds.add(propId);
              }
              // The other half of "did this edit change the file": a full export
              // applies a set DELETION by leaving these lines out, and produces
              // no replacement content to record an emission for. Without this
              // the count would settle from the generator alone and a real
              // deletion would stop counting along with the no-op one (#2474).
              pass.modifications.recordWithheld(entityId, 'property-set');
            }
          }
        }

        if (isTypeClass(pass.effective.typeOf(entityId))) {
          const typeOwnedPsetIds = this.getTypeOwnedHasPropertySetIds(entityId, pass.effective);
          const typeOwnedAffected = new Set<string>();

          for (const psetId of typeOwnedPsetIds) {
            const psetName = this.getPropertySetName(psetId);
            if (!psetName || !psetNames.has(psetName)) continue;
            typeOwnedAffected.add(psetName);
            pass.skipPropertySetIds.add(psetId);
            const propIds = this.getPropertyIdsInSet(psetId);
            for (const propId of propIds) {
              pass.skipPropertySetIds.add(propId);
            }
            // No `recordWithheld` twin of the rel-defined branch above, and
            // deliberately: a name that matches an OWNED pset is either dropped
            // from the resolved list or swapped for the replacement this export
            // generated, so slot 5 always comes back different and the repoint
            // below records the emission for it. A second record here would be
            // one no mutation can kill.
          }

          for (const psetName of psetNames) {
            if (!relDefinedPsetNames.has(psetName)) {
              typeOwnedAffected.add(psetName);
            }
          }

          if (typeOwnedAffected.size > 0) {
            pass.typeOwnedPsetNamesByEntity.set(entityId, typeOwnedAffected);
            pass.typeOwnedPsetIdsByEntity.set(entityId, typeOwnedPsetIds);
            pass.rewrittenEntityIds.add(entityId);
          }
        }
      }

      // Collect modified quantity sets (only if quantities are included)
      if (options.includeQuantities === false) entityQuantMutations.clear();
      // A quantity overlay with nothing under it regenerates a source quantity
      // set from the edited quantity ALONE, and the skip loop below then
      // withholds the source lines that held its siblings (#2487). Unlike
      // properties — whose base falls back to the `baseTable` the view was
      // constructed with — quantities have only the opt-in
      // `setQuantityExtractor`, so the default really is an empty base, and
      // four in-tree callers plus every external embedder never set it.
      //
      // The exporter is the one place that always holds the missing half: it
      // was handed the very store the view is an overlay ON. Supplying it here
      // makes the loss impossible for every caller rather than for the callers
      // we happened to find, and a view that resolves its own quantities (the
      // viewer, MCP, the CLI headless backend) is never overwritten.
      //
      // The extractor closes over ONE store, and the view outlives this export.
      // So it closes over a BOX this class owns instead: a second export of the
      // same view against a DIFFERENT store re-points that box rather than
      // reading the first store's quantities, which is the one way "install only
      // when absent" could have answered from the wrong file. The setter is
      // called at most once per view, so a caller that installs its own
      // extractor at any point — before the first export or after it — keeps it.
      //
      // `hasQuantityBase` and `setQuantityExtractor` are probed, like every other
      // optional view capability this class reaches for (`peekNextExpressId`,
      // `getNewEntities`, `getEntityTypeMutation`): `MutablePropertyView` is
      // published API arriving from a separately versioned package, and callers
      // pass partial and duck-typed views. `hasQuantityBase` is newer than
      // `setQuantityExtractor`, and without it there is no way to tell an empty
      // base from a caller-supplied one — so an older view falls back to the
      // pre-#2487 behaviour (no base supplied) rather than risk overwriting one.
      const quantityView = this.mutationView;
      if (
        entityQuantMutations.size > 0 &&
        typeof quantityView.setQuantityExtractor === 'function' &&
        typeof quantityView.hasQuantityBase === 'function'
      ) {
        const installed = exporterQuantityBase.get(quantityView);
        if (installed) {
          // Ours, or a caller's that replaced ours: re-pointing the box is a
          // no-op in the second case, and calling the setter again is what
          // would not be.
          installed.store = this.dataStore;
        } else if (!quantityView.hasQuantityBase()) {
          const box = { store: this.dataStore };
          exporterQuantityBase.set(quantityView, box);
          quantityView.setQuantityExtractor((id: number) => extractQuantitiesOnDemand(box.store, id));
        }
      }
      for (const [entityId, qsetNames] of entityQuantMutations) {
        // Same rule as the property loop above: a deleted entity removes nothing.
        if (pass.effective.isDeleted(entityId)) continue;
        pass.modifiedEntities.add(entityId);
        // See the property loop above — an overlay-created entity is counted as
        // new, not modified. The pset loop's own nomination no longer has to be
        // excluded to avoid a double count: the ledger settles per ENTITY, so a
        // host with both a pset and a qset edit counts once whatever is
        // nominated. Nominating both buys the opposite — an accurate warning
        // when the qset half is the half a delta cannot carry.
        //
        // Settled from effect like its property-set twin (#2474). The reachable
        // no-op here is an UNDONE quantity-set creation whose name matches NO
        // source set: `getMutations()` is append-only, so the `CREATE_QUANTITY`
        // record still names the qset after `removeQuantityMutation` has taken
        // it out of the overlay, and the generator below then finds nothing to
        // write. The same undo against a COLLIDING name is not a no-op — it
        // withholds the source set's lines — which is what the skip loop's
        // `recordWithheld` below settles.
        if (!pass.isOverlayCreated(entityId) && pass.hasEmittableHostBytes(entityId)) {
          pass.modifications.nominate(entityId, 'quantity-set');
        }

        const allQsets = this.mutationView.getQuantitiesForEntity(entityId);
        const relevantQsets = allQsets.filter((qset: QuantitySet) => qsetNames.has(qset.name));

        if (relevantQsets.length > 0) {
          pass.newQuantitySets.push({ entityId, qsets: relevantQsets });
        }

        // The names this export is actually WRITING a replacement for. The
        // affected-name set is not the same thing: it comes from the session's
        // append-only mutation history, which keeps naming a quantity set after
        // an undo has taken it back out of the overlay, so a Ctrl+Z used to
        // withhold a source `IfcElementQuantity` that nothing regenerated.
        //
        // A quantity-set REMOVAL is the one case where withholding WITHOUT a
        // replacement is the intent rather than the bug. It had no public
        // populator when #2487 wrote that rule, so the rule read "always the
        // bug"; `MutablePropertyView.deleteQuantitySet` (#2508) gives it one,
        // and the deleted set is now asked for by name below. Without that, the
        // panel hid a base quantity set the exported file still carried.
        const regeneratedQsetNames = new Set(relevantQsets.map((qset: QuantitySet) => qset.name));

        // Skip original quantity set entities (IfcElementQuantity).
        // Same per-entity index lookup as the property branch above.
        const rels = relDefinesByEntity.get(entityId);
        if (rels) {
          for (const { relId, psetId: relatedPsetId } of rels) {
            const qsetName = this.getElementQuantityName(relatedPsetId);
            const deleted = qsetName !== null
              && this.mutationView.isQuantitySetDeleted?.(entityId, qsetName) === true;
            if (qsetName && (regeneratedQsetNames.has(qsetName) || deleted)) {
              pass.skipRelationshipIds.add(relId);
              pass.skipPropertySetIds.add(relatedPsetId);
              const quantIds = this.getPropertyIdsInSet(relatedPsetId);
              for (const quantId of quantIds) {
                pass.skipPropertySetIds.add(quantId);
              }
              // The withheld half, exactly as the rel-defined property branch
              // above. This loop has just decided that #`relatedPsetId`, its
              // quantity atoms and the relationship that attached them do NOT
              // go into the file; whether anything is generated to take their
              // place is decided elsewhere, and is not this branch's to assume.
              //
              // It IS assumable for the pset side and not here, and the
              // difference is where the two read their base from.
              // `getForEntity` merges the overlay over the base pset walk, so a
              // name the session touched but did not change still resolves to
              // source content and is regenerated.
              // `getQuantitiesForEntity` merges the overlay over
              // `quantityExtractor`, which is OPT-IN: it defaults to null, and
              // several in-tree callers wire the property extractor beside it
              // and not it (`cli/commands/mutate.ts`, `gym.ts`,
              // `generate-spaces.ts`, `export/demesh-session.ts`), as does any
              // external embedder of these two published packages. With no
              // extractor the base is empty and the overlay is the only source,
              // so a qset the overlay no longer holds resolves to nothing.
              //
              // Which makes this reachable through an UNDONE quantity-set
              // creation whose name COLLIDES with a source set:
              // `setQuantity(id, 'Qto_WallBaseQuantities', ...)` followed by the
              // `removeQuantityMutation` that mutationSlice runs on Ctrl+Z. The
              // append-only history still names the qset, so this branch
              // withholds the source lines; the overlay is empty again, so
              // nothing is regenerated. The export drops the source quantity set
              // — a real change to the file, and a data-loss bug of its own
              // (#2487) — and this call is what stops the count from calling it
              // nothing.
              pass.modifications.recordWithheld(entityId, 'quantity-set');
            }
          }
        }
      }

      for (const [entityId] of pass.modifiedAttributes) {
        // An overlay-CREATED entity carrying attribute edits is emitted once,
        // by the new-entities pass, and already counted in `newEntityCount`.
        // Counting it here too made the header claim two affected entities for
        // one created-then-renamed wall.
        if (pass.isOverlayCreated(entityId)) continue;
        // A source entity with no bytes never gets its line rewritten (the
        // source-iteration pass skips it), so an attribute edit against it
        // must not inflate the count either.
        if (!pass.hasEmittableHostBytes(entityId)) continue;
        // Under `deltaOnly` this only NOMINATES the host's ATTRIBUTE edits:
        // nothing writes an in-place attribute edit into a delta except the
        // type-object line rewrite, so the ledger drops it at settle time
        // unless that pass reports having carried it (#2462). That nomination
        // is deliberately made at INTENT: the per-kind warning exists to NAME
        // an edit the delta could not carry, and an undeliverable edit is
        // exactly the one that must still be named.
        //
        // A FULL export has no such warning, so an edit that resolved to
        // nothing has nothing to say and nothing to claim — it waits for the
        // rewrite instead. `setAttribute` to the value already in the slot, and
        // `setAttribute` naming a slot the class does not declare, both leave
        // the line byte-identical and used to count anyway (#2483).
        //
        // Recorded unconditionally. It used to be skipped for a host that also
        // had a pset or qset edit, because the count was per entity and the
        // other loop had already nominated it — which is exactly what let a
        // pset emission mark the rename delivered and suppress its warning. The
        // ledger de-duplicates the COUNT per entity now, so the two edits can
        // and must be nominated separately.
        pass.inPlaceNominees.attribute.add(entityId);
        if (options.deltaOnly === true) pass.modifications.nominate(entityId, 'attribute');
      }
    }

    // Process georeferencing mutations (only when applyMutations is enabled)
    if (options.applyMutations !== false && options.georefMutations) {
      const gm = options.georefMutations;
      // `effective.byType`, not the raw index: a source IfcProjectedCRS the
      // session tombstoned is still in `dataStore.entityIndex`, so the modify
      // branch below would queue attribute edits against an id the
      // source-iteration pass then skips — the replacement georeferencing
      // vanishes from the file with no error. `effective.byType` drops
      // tombstones and adds overlay-created records, which the new-entities
      // pass applies `modifiedAttributes` to, so both branches agree on which
      // georeferencing entities exist (#2048).
      const existingCrsIds = pass.effective.byType.get('IFCPROJECTEDCRS');
      const existingMcIds = pass.effective.byType.get('IFCMAPCONVERSION');

      // Modify existing IfcProjectedCRS
      if (gm.projectedCRS && existingCrsIds?.length) {
        const entityId = existingCrsIds[0];
        if (!pass.modifiedAttributes.has(entityId)) {
          pass.modifiedAttributes.set(entityId, new Map());
        }
        const attrMap = pass.modifiedAttributes.get(entityId)!;
        const crs = gm.projectedCRS;
        let changed = false;
        if (crs.name !== undefined) { attrMap.set('Name', String(crs.name)); changed = true; }
        if (crs.description !== undefined) { attrMap.set('Description', String(crs.description)); changed = true; }
        if (crs.geodeticDatum !== undefined) { attrMap.set('GeodeticDatum', String(crs.geodeticDatum)); changed = true; }
        if (crs.verticalDatum !== undefined) { attrMap.set('VerticalDatum', String(crs.verticalDatum)); changed = true; }
        if (crs.mapProjection !== undefined) { attrMap.set('MapProjection', String(crs.mapProjection)); changed = true; }
        if (crs.mapZone !== undefined) { attrMap.set('MapZone', String(crs.mapZone)); changed = true; }
        if (crs.mapUnit !== undefined) {
          const mapUnitRef = this.resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, pass.effective);
          attrMap.set('MapUnit', `#${mapUnitRef}`);
          changed = true;
        }
        if (changed) {
          pass.modifiedEntities.add(entityId);
          // Queued as attribute edits, which only the source-iteration pass
          // writes — so under `deltaOnly` this nominates and settle decides.
          // Recorded even when the host is already in `modifiedEntities`: that
          // guard existed to stop a second COUNT, which the ledger now handles
          // per entity, and suppressing the nomination would hide a dropped
          // georeferencing edit behind an unrelated edit to the same record.
          //
          // `changed` above is INTENT — a field was supplied, not a field that
          // differs from the one in the file. Writing `name: 'EPSG:2056'` over
          // an IfcProjectedCRS already named `EPSG:2056` leaves the line
          // byte-identical, so a full export waits for the rewrite exactly as
          // the plain attribute site does (#2483).
          if (pass.hasEmittableHostBytes(entityId)) {
            pass.inPlaceNominees.georeferencing.add(entityId);
            if (options.deltaOnly === true) pass.modifications.nominate(entityId, 'georeferencing');
          }
        }
      }

      // Modify existing IfcMapConversion
      if (gm.mapConversion && existingMcIds?.length) {
        const entityId = existingMcIds[0];
        if (!pass.modifiedAttributes.has(entityId)) {
          pass.modifiedAttributes.set(entityId, new Map());
        }
        const attrMap = pass.modifiedAttributes.get(entityId)!;
        const mc = gm.mapConversion;
        let changed = false;
        if (mc.eastings !== undefined) { attrMap.set('Eastings', String(mc.eastings)); changed = true; }
        if (mc.northings !== undefined) { attrMap.set('Northings', String(mc.northings)); changed = true; }
        if (mc.orthogonalHeight !== undefined) { attrMap.set('OrthogonalHeight', String(mc.orthogonalHeight)); changed = true; }
        if (mc.xAxisAbscissa !== undefined) { attrMap.set('XAxisAbscissa', String(mc.xAxisAbscissa)); changed = true; }
        if (mc.xAxisOrdinate !== undefined) { attrMap.set('XAxisOrdinate', String(mc.xAxisOrdinate)); changed = true; }
        if (mc.scale !== undefined) { attrMap.set('Scale', String(mc.scale)); changed = true; }
        if (changed) {
          pass.modifiedEntities.add(entityId);
          // Same as the IfcProjectedCRS branch above, effect gate included.
          if (pass.hasEmittableHostBytes(entityId)) {
            pass.inPlaceNominees.georeferencing.add(entityId);
            if (options.deltaOnly === true) pass.modifications.nominate(entityId, 'georeferencing');
          }
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
          ? `#${this.resolveMapUnitReference(String(crs.mapUnit), pass.newGeorefLines, pass.effective)}`
          : '$';
        pass.newGeorefLines.push(`#${crsId}=IFCPROJECTEDCRS(${name},${desc},${datum},${vDatum},${proj},${zone},${mapUnitRef});`);
        pass.newEntityCount++;

        // Find IfcGeometricRepresentationContext as SourceCRS for MapConversion
        const contextId = this.findPreferredGeometricRepresentationContextId(pass.effective);

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
          pass.newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${crsId},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
          pass.newEntityCount++;
        } else {
          this.reportMapConversionRefused(pass.warnings);
        }
      } else if (gm.mapConversion && !existingMcIds?.length && existingCrsIds?.length) {
        // CRS exists but no MapConversion — create just the conversion
        const contextId = this.findPreferredGeometricRepresentationContextId(pass.effective);
        if (contextId) {
          const mc = gm.mapConversion;
          const mcId = this.nextExpressId++;
          const eastings = toStepReal(Number(mc.eastings) || 0);
          const northings = toStepReal(Number(mc.northings) || 0);
          const height = toStepReal(Number(mc.orthogonalHeight) || 0);
          const abscissa = mc.xAxisAbscissa !== undefined ? toStepReal(Number(mc.xAxisAbscissa)) : '$';
          const ordinate = mc.xAxisOrdinate !== undefined ? toStepReal(Number(mc.xAxisOrdinate)) : '$';
          const scale = mc.scale !== undefined ? toStepReal(Number(mc.scale)) : '$';
          pass.newGeorefLines.push(`#${mcId}=IFCMAPCONVERSION(#${contextId},#${existingCrsIds[0]},${eastings},${northings},${height},${abscissa},${ordinate},${scale});`);
          pass.newEntityCount++;
        } else {
          this.reportMapConversionRefused(pass.warnings);
        }
      } else if (gm.mapConversion && !existingMcIds?.length && !existingCrsIds?.length) {
        // A map conversion was requested, but there is no IfcProjectedCRS to
        // reference as TargetCRS: none was requested (the first branch above
        // didn't fire) and none exists in the file. Both CREATE branches are
        // skipped, so nothing is attempted — report the refusal so the
        // caller isn't left with an empty stats.warnings and no hint (#2105).
        this.reportMapConversionRefusedNoCrs(pass.warnings);
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
      && pass.modifiedEntities.size === 0
      && overlayNewEntityCount === 0
      && pass.newGeorefLines.length === 0
    ) {
      const emptyContent = new TextEncoder().encode(pass.buildHeader(0) + 'DATA;\nENDSEC;\nEND-ISO-10303-21;\n');
      return {
        content: emptyContent,
        stats: {
          entityCount: 0,
          newEntityCount: 0,
          modifiedEntityCount: 0,
          fileSize: emptyContent.byteLength,
          warnings: pass.warnings,
        },
      };
    }


    // A modified pset is replaced wholesale, which skips ALL of its member atoms.
    // But IFC exporters deduplicate identical Pset_*Common atoms (e.g. one
    // IsExternal IfcPropertySingleValue shared by dozens of psets), so skipping a
    // shared atom would orphan every OTHER pset that still references it, leaving
    // dangling refs and an invalid file. Keep any atom a surviving container needs.
    this.retainSharedAtoms(pass.skipPropertySetIds, pass.allowedEntityIds);

    // Export original entities from source buffer, SKIPPING modified property sets
    if (!options.deltaOnly && this.dataStore.source) {
      const source = this.dataStore.source;

      // Extract existing entities from source. The effective index has already
      // dropped everything the overlay tombstoned, so there is no separate
      // deleted check to forget here.
      for (const [expressId, entityRef] of pass.effective) {
        // Skip overlay-only entities — emitted by the new-entities pass below.
        // A ref this source cannot address is skipped by the same test rather
        // than decoded: `decodeUtf8` clamps such a range and the empty string
        // it returns used to be pushed into the file as a blank line, leaving
        // every generated record that names the host dangling (#2491).
        if (!pass.isReadableSourceRef(entityRef)) {
          continue;
        }

        // Skip entities outside the visible closure
        if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(expressId)) {
          continue;
        }

        // Skip property sets/relationships that are being replaced
        if (pass.skipPropertySetIds.has(expressId) || pass.skipRelationshipIds.has(expressId)) {
          continue;
        }

        // Skip type entities whose HasPropertySets attribute will be rewritten
        if (pass.rewrittenEntityIds.has(expressId)) {
          continue;
        }

        // Skip if we're only doing geometry or specific types
        const entityType = entityRef.type.toUpperCase();

        // Skip geometry if not included
        if (options.includeGeometry === false && this.isGeometryEntity(entityType)) {
          continue;
        }

        // Get original entity text — decodeRange handles SAB-backed
        // sources (Firefox/Chrome reject `TextDecoder.decode()` on a
        // SharedArrayBuffer-backed view; the parser deliberately keeps
        // `source` zero-copy SAB-backed for worker sharing).
        const entityText = decodeRange(
          source,
          entityRef.byteOffset,
          entityRef.byteOffset + entityRef.byteLength
        );
        // Retype, named attribute edits and positional edits, in that order.
        // Shared verbatim with the type-object `HasPropertySets` rewrite below,
        // which writes the line this pass would otherwise have written.
        const mutated = this.applySourceLineMutations(
          expressId,
          entityText,
          entityRef.type,
          pass.modifiedAttributes.get(expressId),
          pass.sourceSchema,
          pass.overlayActive,
        );
        let nextEntityText = mutated.text;

        // A hidden PRODUCT's own line is already out of the export via
        // `allowedEntityIds`, and a TOMBSTONED entity's via `effective` — this
        // is the relationship that NAMED either one. `IFCREL*` is an
        // unconditional root (see `getVisibleEntityIds`), so its bytes reach
        // here unfiltered even when one of the ids they name was just
        // excluded; left alone that ships a `#N` with no `#N=` line, whether
        // the exclusion came from `visibleOnly` or from a plain deletion
        // (#2398). Checked before the nomination below: a relationship this
        // withholds must not also be counted as a delivered modification.
        //
        // Classified by the EFFECTIVE type (`effective.effectiveType`), not
        // the authored `entityType` above: a retype can move a record across
        // the `IFCREL*` boundary in either direction (`applySourceLineMutations`
        // already rewrote `nextEntityText` to the new class), and this check
        // has to agree with what actually got written, the same way
        // `getVisibleEntityIds` already does for the visibility walk itself.
        const effectiveRelType = pass.effective.effectiveType(expressId, entityRef.type).toUpperCase();
        if (mayNameExcludedRefs && effectiveRelType.startsWith('IFCREL')) {
          const filtered = filterHiddenRefsFromRelationshipLine(nextEntityText, pass.isExcludedFromRelationshipRefs);
          if (filtered === null) continue;
          nextEntityText = filtered;
        }

        // A retype or a positional edit that CHANGED the line is what makes
        // this entity count; a named attribute edit was already nominated by
        // the collection pass. Both flags report effect, so retyping an entity
        // to the class it already is — or writing a slot the token it already
        // holds — no longer claims a modification over a line the export left
        // byte-identical. This pass is full-export-only (`deltaOnly` skips it
        // wholesale), so nomination IS emission here and the kinds only have to
        // be right for the entity count — which is per entity, hence unchanged.
        if (mutated.retyped || mutated.positional) pass.modifiedEntities.add(expressId);
        if (mutated.retyped) pass.modifications.nominate(expressId, 'retype');
        if (mutated.positional) pass.modifications.nominate(expressId, 'positional');
        // The named-attribute kinds join them here rather than at their
        // collection sites, for the same reason and on the same signal (#2483).
        // This pass is full-export-only, so there is nothing to gate.
        nominateDeliveredInPlaceEdits(pass.modifications, expressId, mutated, pass.inPlaceNominees);

        // Apply schema conversion if exporting to a different schema version
        if (pass.converting) {
          const converted = convertStepLine(nextEntityText, pass.sourceSchema, pass.schema, options.guidRandom);
          if (converted !== null) {
            pass.entities.push(converted);
          }
          // null means entity should be skipped (no valid representation in target schema)
        } else {
          pass.entities.push(nextEntityText);
        }
      }
    }

    // Generate new property entities for mutations (these REPLACE the skipped ones)
    const generatedTypeOwnedPsetIds = new Map<number, Map<string, number>>();
    for (const { entityId, psets } of pass.newPropertySets) {
      // Nothing may be emitted FOR an entity that gets no defining line —
      // see `willBeEmitted` (#1978, #2030, #2012).
      if (!pass.willBeEmitted(entityId)) continue;
      const newEntities = this.generatePropertySetEntities(
        entityId,
        psets,
        pass.willBeEmitted,
        pass.effective,
        pass.typeOwnedPsetNamesByEntity.get(entityId),
        options.guidRandom
      );
      pass.entities.push(...newEntities.lines);
      pass.newEntityCount += newEntities.count;
      // Replacement content for this host actually landed, so a delta really
      // does carry its PROPERTY-SET modification — and only that one (#2462).
      if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'property-set');
      generatedTypeOwnedPsetIds.set(entityId, newEntities.generatedTypeOwnedPsetIds);
    }

    // Point every affected type object's HasPropertySets at the psets this
    // export generated. One loop, because a type whose affected psets produced
    // no replacement content (a deletion) needs exactly the same resolution
    // with an empty replacement map.
    for (const [entityId, typeOwnedPsetNames] of pass.typeOwnedPsetNamesByEntity) {
      // `entityId` here is a TYPE object rather than an element; `willBeEmitted`
      // resolves either the same way (#2030).
      if (!pass.willBeEmitted(entityId)) continue;
      const resolved = resolveTypeOwnedPsetIds(
        pass.typeOwnedPsetIdsByEntity.get(entityId) ?? [],
        typeOwnedPsetNames,
        generatedTypeOwnedPsetIds.get(entityId) ?? new Map(),
        (psetId) => this.getPropertySetName(psetId),
      );
      if (pass.effective.isOverlayCreated(entityId)) {
        // No source line to rewrite: the new-entities pass writes this record
        // from its authored payload, so the list rides in as a slot override.
        pass.overlayTypeOwnedPsets.set(
          entityId,
          resolved.length > 0 ? resolved.map((id) => `#${id}`) : null,
        );
        continue;
      }
      // This line REPLACES the one the source-iteration pass would have
      // written — `rewrittenEntityIds` makes that pass skip the entity — so it
      // has to carry the entity's other edits too, and it has to apply them
      // the way that pass does. It used to replace slot 5 and nothing else,
      // which dropped the rename in `setAttribute(id,'Name',…)` +
      // `addPropertySet(id,…)`, and then, once renames were special-cased
      // here, still dropped retypes and positional edits — same line, same
      // silence. So run the ONE pipeline both passes share and replace
      // `HasPropertySets` on its output. Order matters: see
      // {@link applySourceLineMutations}.
      const record = pass.effective.get(entityId);
      let sourceLine: string | null = null;
      let mutated: SourceLineMutations | null = null;
      // One narrowed block for both calls: `record` is in scope for the decode
      // AND for the record type below, with no non-null assertion to keep true
      // by hand. `byteOffset >= 0` is the same "are there real source bytes"
      // test the source-iteration pass makes — an overlay-authored record
      // carries `-1` there, and decoding from it would read another entity's
      // bytes rather than fall through to the no-source-bytes branch.
      // `isReadableSourceRef` folds in the `byteOffset >= 0 && byteLength > 0`
      // test this used to make by hand, and adds the bound the invariant used
      // to supply (#2491).
      if (record && pass.isReadableSourceRef(record)) {
        sourceLine = decodeRange(
          this.dataStore.source,
          record.byteOffset,
          record.byteOffset + record.byteLength,
        );
        // The RECORD's class is the from-type: the bytes are still the source
        // class, whatever `typeOf` now says the entity effectively is.
        mutated = this.applySourceLineMutations(
          entityId,
          sourceLine,
          record.type,
          pass.modifiedAttributes.get(entityId),
          pass.sourceSchema,
          pass.overlayActive,
        );
      }
      if (mutated === null) {
        // `willBeEmitted` already required real source bytes for a non-overlay
        // record, so this is only reachable with no source buffer at all —
        // in which case the source-iteration pass never ran either and there is
        // nothing to lose. Say it anyway; the pset edit is still going nowhere.
        pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'no-source-bytes'));
        // The line above IS the report, so the ledger must not add a second,
        // vaguer one blaming the delta format for a drop the format did not
        // cause.
        pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
        continue;
      }
      const { line, repointed } = rewriteTypeOwnedPsetLine(mutated.text, resolved);
      if (repointed) {
        // A repoint that resolves to the list the line ALREADY names changes
        // nothing, and it is reachable: deleting a pset name the type object
        // does not own leaves every original id in place (it is "affected" but
        // matches none of them) and generates no replacement, so slot 5 comes
        // back byte-identical. Same rule as the fallback branch below — an
        // unchanged line has no place in a delta, and claiming it delivered the
        // edit would put a modification in the header over a line that carries
        // none. A FULL export still emits it: `rewrittenEntityIds` made the
        // source-iteration pass skip this entity, so withholding the line there
        // would delete the record from the file (#2469).
        const changed = line !== sourceLine;
        if (options.deltaOnly !== true || changed) {
          pass.rewrittenEntityLines.set(entityId, line);
        }
        // A rewritten source line IS in the delta — the one in-place change a
        // delta does carry today (#2462). The repoint itself delivers the
        // property-set edit that put this host in the loop; the rest of the
        // line delivers whichever in-place edits the pipeline applied to it.
        if (changed) {
          pass.modifications.recordEmitted(entityId, 'property-set');
          recordSourceLineDelivery(pass.modifications, entityId, mutated);
          // `rewrittenEntityIds` made the source-iteration pass skip this
          // host, so this line is the ONLY place a full export can see its
          // named-attribute edits land — per site, not per feature (#2483).
          nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
        }
        continue;
      }
      // A malformed source line — too few arguments to have a slot 5, or not
      // parseable as a STEP record at all. The entity must still come out:
      // `rewrittenEntityIds` made the source-iteration pass skip it, so
      // dropping the line here deletes the whole record from the file (#2469).
      pass.warnings.push(typeOwnedPsetRewriteWarning(entityId, 'unparseable-line'));
      // Same as the `no-source-bytes` branch: the property-set edit is
      // genuinely undelivered — the repoint is what would have delivered it and
      // it did not happen — but this warning already says so, precisely, so the
      // ledger stays quiet about that pair rather than duplicating it. (When
      // the affected psets produced replacement content, the property-set pass
      // above has already recorded the emission, and an emission outranks an
      // acknowledgement.)
      pass.modifications.acknowledgeUndelivered(entityId, 'property-set');
      // `line` is byte-for-byte what the source-iteration pass would have
      // written, so emit it wherever that pass would have run. Under
      // `deltaOnly` it does not run, and a line the mutation pipeline left
      // identical to its source is not a change — it has no place in a delta.
      const changed = line !== sourceLine;
      if (options.deltaOnly !== true || changed) {
        pass.rewrittenEntityLines.set(entityId, line);
      }
      // The ledger stays honest about WHICH modification landed: the
      // property-set edit that nominated this host is the thing that just
      // failed, so only the entity's OTHER edits are in this line. Under the
      // per-kind keying that comes out as `attribute/retype/positional:
      // delivered, property-set: undelivered` — the host still counts once,
      // because a real change of its did land.
      if (changed) {
        recordSourceLineDelivery(pass.modifications, entityId, mutated);
        // Same site rule as the repoint branch above: the failed repoint is
        // what did not land, and the line still carries the host's OTHER edits.
        nominateDeliveredInPlaceEdits(pass.modifications, entityId, mutated, pass.inPlaceNominees);
      }
    }

    // Generate new quantity entities for mutations
    for (const { entityId, qsets } of pass.newQuantitySets) {
      if (!pass.willBeEmitted(entityId)) continue;
      const newEntities = this.generateQuantitySetEntities(entityId, qsets, pass.willBeEmitted, options.guidRandom);
      pass.entities.push(...newEntities.lines);
      pass.newEntityCount += newEntities.count;
      if (newEntities.lines.length > 0) pass.modifications.recordEmitted(entityId, 'quantity-set');
    }

    for (const rewrittenLine of pass.rewrittenEntityLines.values()) {
      pass.entities.push(rewrittenLine);
    }

    // Add new georeferencing entities (IfcProjectedCRS, IfcMapConversion)
    for (const line of pass.newGeorefLines) {
      pass.entities.push(line);
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
        if (pass.allowedEntityIds !== null && !pass.allowedEntityIds.has(entity.expressId)) {
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
            (value, i) => serializeAttributeSlot(entity.type, i, value, pass.sourceSchema),
          );
          const { tokens } = retypeArgTokens(
            srcTokens,
            entity.type,
            effectiveType,
            typeMut.predefinedType ?? null,
            pass.sourceSchema,
          );
          argsText = tokens.join(',');
        } else {
          argsText = serializeEntityArgs(entity.type, entity.attributes, pass.sourceSchema);
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
        const attributeOverrides = pass.modifiedAttributes.get(entity.expressId) ?? null;
        const queuedPositional = typeof this.mutationView.getPositionalMutationsForEntity === 'function'
          ? this.mutationView.getPositionalMutationsForEntity(entity.expressId)
          : null;
        // A created TYPE object owns its psets through HasPropertySets, and the
        // ids of the psets this export generated are only known now — so they
        // arrive as one more slot override rather than through the overlay.
        // `has`, not `??`, for the same reason `overlaySlotValue` gives: the
        // stored value is deliberately null when the resolved list is empty.
        const positionalOverrides = pass.overlayTypeOwnedPsets.has(entity.expressId)
          ? new Map(queuedPositional).set(
              HAS_PROPERTY_SETS_SLOT,
              pass.overlayTypeOwnedPsets.get(entity.expressId) ?? null,
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
            pass.sourceSchema,
          );
        }
        let line: string | null = `#${entity.expressId}=${upperType}(${argsText});`;
        // Same gap as the source-iteration pass, for an overlay-authored
        // relationship instead of a parsed one (#2398).
        if (mayNameExcludedRefs && upperType.startsWith('IFCREL')) {
          line = filterHiddenRefsFromRelationshipLine(line, pass.isExcludedFromRelationshipRefs);
          if (line === null) continue;
        }
        if (pass.converting) {
          const converted = convertStepLine(line, pass.sourceSchema, pass.schema, options.guidRandom);
          if (converted !== null) {
            pass.entities.push(converted);
            pass.newEntityCount++;
          }
        } else {
          pass.entities.push(line);
          pass.newEntityCount++;
        }
      }
    }

    // Settle the count against what the passes above actually wrote, and say
    // out loud every KIND of edit a delta could not carry, per host. Silence
    // was the other half of #2462: `deltaOnly` skips the source-iteration pass,
    // so an in-place edit to a source entity is not in the file and never was —
    // the header merely used to claim otherwise.
    const { modifiedEntityCount, warnings: deltaWarnings } = pass.modifications.settle();
    pass.warnings.push(...deltaWarnings);

    // Assemble final file as Uint8Array chunks to avoid V8 string length limit.
    // The header is built last so its provenance item reflects the real count.
    const header = pass.buildHeader(pass.newEntityCount + modifiedEntityCount);
    const content = assembleStepBytes(header, pass.entities);

    return {
      content,
      stats: {
        entityCount: pass.entities.length,
        newEntityCount: pass.newEntityCount,
        modifiedEntityCount,
        fileSize: content.byteLength,
        warnings: pass.warnings,
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
    // Readability rather than presence, as everywhere else (#2491). A clamped
    // decode would match nothing here, so this is tidiness rather than a bug —
    // but the gates in this file agree on one predicate now.
    if (entityRef && this.isReadableSourceRef(entityRef)) {
      const entityText = decodeRange(
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
    effective: EffectiveEntityIndex,
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

        // `prop.dataType`, not `prop.type` alone: regenerating the set rewrites
        // every property in it, and the shape-derived primitive would re-declare
        // the ones nobody edited (`IFCTEXT` → `IFCLABEL`, `IFCLENGTHMEASURE` →
        // `IFCREAL`). See `declared-property-type.ts` for when the source token
        // is trusted (#2482).
        const valueStr = serializeNominalValue(prop.value, prop.type, prop.dataType);
        const unitId = prop.unit ? this.findUnitId(prop.unit, effective) : null;
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
   * THE mutation pipeline for a line read out of the source buffer: retype,
   * then named attribute edits, then positional edits.
   *
   * **One implementation, two call sites**, and that is the whole point. Two
   * passes can write the defining line of a source entity — the
   * source-iteration pass, and the type-object `HasPropertySets` rewrite that
   * REPLACES it (`rewrittenEntityIds` makes the source pass skip those ids).
   * The rewrite used to do its own thing (replace slot 5, nothing else), so
   * every other edit to a type object with a type-owned pset edit was dropped
   * in silence: first the renames (#2462 follow-up), and after those were
   * special-cased here, still the retypes and the positional edits. Whatever
   * the source pass applies, the rewrite has to apply too, or the next edit
   * kind added to one site goes missing at the other.
   *
   * The order is load-bearing:
   *
   *   - the retype runs FIRST so named attribute edits resolve against the
   *     TARGET class's attribute names, and so positional slots are indexed
   *     into the retyped argument list;
   *   - the `HasPropertySets` replacement (rewrite path only) runs LAST, on
   *     the text this returns. Run it first and a positional edit to slot 5 —
   *     or a retype's argument-list rebuild — overwrites the resolved pset
   *     list with the stale one, which is the same silent drop one slot over.
   *
   * The expressId is unchanged by all of this, so geometry / placement /
   * representation and every IfcRel* reference (keyed by #id) carry over.
   *
   * All three flags report EFFECT, not intent — each is the answer to "did this
   * operation change the line", measured across that operation alone. The count
   * and the ledger are claims about the FILE, so an edit that resolves to the
   * text already there has delivered nothing and must not be reported: retyping
   * an entity to the class it already is, or writing a positional slot the token
   * it already holds, used to count as a modification and reach the ledger as a
   * landed edit, over a byte-identical line. Discarded edits read the same way:
   * `applyAttributeMutations` drops a name its class has no slot for and
   * `retypeStepLine` returns an unparseable line untouched, and neither is a
   * modification of anything.
   *
   * `retyped` / `positional` matter most in a FULL export, which is where the
   * two are nominated (their edits have no earlier nomination site); named
   * attribute edits are nominated by the collection pass and `attributed` only
   * settles their delivery.
   */
  private applySourceLineMutations(
    expressId: number,
    entityText: string,
    recordType: string,
    attributeMutations: Map<string, string> | undefined,
    sourceSchema: IfcSchemaVersion,
    overlayActive: boolean,
  ): SourceLineMutations {
    let text = entityText;
    let workingType = recordType.toUpperCase();

    const typeMutation = overlayActive && typeof this.mutationView!.getEntityTypeMutation === 'function'
      ? this.mutationView!.getEntityTypeMutation(expressId)
      : null;
    let retyped = false;
    if (typeMutation) {
      const beforeRetype = text;
      text = retypeStepLine(
        text,
        recordType,
        typeMutation.newType,
        typeMutation.predefinedType ?? null,
        sourceSchema,
      );
      retyped = text !== beforeRetype;
      // Set even for a no-op retype: the entity IS the target class from here
      // on, so the named and positional edits below must resolve against it.
      workingType = typeMutation.newType.toUpperCase();
    }

    // `applyAttributeMutations` returns its input UNCHANGED when it wrote
    // nothing — no slot resolved for any of the names, or the line does not
    // parse — so comparing is what tells the ledger whether a named attribute
    // edit was really carried, rather than merely attempted.
    let attributed = false;
    if (attributeMutations && attributeMutations.size > 0) {
      const beforeAttributes = text;
      text = this.applyAttributeMutations(text, workingType, attributeMutations);
      attributed = text !== beforeAttributes;
    }

    const positionals = overlayActive && typeof this.mutationView!.getPositionalMutationsForEntity === 'function'
      ? this.mutationView!.getPositionalMutationsForEntity(expressId)
      : null;
    let positional = false;
    if (positionals && positionals.size > 0) {
      const beforePositionals = text;
      text = this.applyPositionalMutations(text, positionals, workingType, sourceSchema);
      positional = text !== beforePositionals;
    }

    return { text, attributed, retyped, positional };
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

  private resolveMapUnitReference(unitName: string, newGeorefLines: string[], effective: EffectiveEntityIndex): number {
    const normalized = this.normalizeMapUnitName(unitName);
    const existing = this.findLengthUnitReference(normalized, effective);
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

  /**
   * `effective` filters the candidates the same way the georef reads above do:
   * returning a tombstoned unit id hands the caller a `#id` for a line the
   * export never writes. Returning null instead makes `resolveMapUnitReference`
   * synthesise a fresh unit, which is the outcome a deleted unit deserves.
   */
  private findLengthUnitReference(preferredUnitName: string, effective: EffectiveEntityIndex): number | null {
    if (!this.entityExtractor) return null;

    // Only source records carry the bytes `extractEntity` reads, so an
    // overlay-created project is skipped rather than shadowing the file's own.
    const projectId = (effective.byType.get('IFCPROJECT') ?? []).find((id) => this.dataStore.entityIndex.byId.has(id));
    const projectRef = projectId !== undefined ? this.dataStore.entityIndex.byId.get(projectId) : undefined;
    const project = projectRef ? this.entityExtractor.extractEntity(projectRef) : null;
    const unitAssignmentId = project?.attributes?.[8];
    if (typeof unitAssignmentId !== 'number' || effective.isDeleted(unitAssignmentId)) return null;

    const unitAssignmentRef = this.dataStore.entityIndex.byId.get(unitAssignmentId);
    const unitAssignment = unitAssignmentRef ? this.entityExtractor.extractEntity(unitAssignmentRef) : null;
    const units = unitAssignment?.attributes?.[0];
    if (!Array.isArray(units)) return null;

    for (const unitId of units) {
      if (typeof unitId !== 'number' || effective.isDeleted(unitId)) continue;
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

  /**
   * Record that a requested IfcMapConversion could not be written because
   * there is no IfcProjectedCRS to attach it to — a different refusal from
   * {@link reportMapConversionRefused}: "no CRS to attach it to" rather than
   * "no context to reference" (#2105).
   */
  private reportMapConversionRefusedNoCrs(warnings: string[]): void {
    warnings.push(MAP_CONVERSION_WITHOUT_CRS_WARNING);
    console.warn(`[StepExporter] ${MAP_CONVERSION_WITHOUT_CRS_WARNING}`);
  }


  /**
   * `effective` again: the id returned here becomes the new IfcMapConversion's
   * SourceCRS, so a tombstoned context would leave the created line pointing at
   * a record the export skips — a dangling reference and an invalid file.
   */
  private findPreferredGeometricRepresentationContextId(effective: EffectiveEntityIndex): number | null {
    if (!this.entityExtractor) return null;

    const contextIds = (effective.byType.get('IFCGEOMETRICREPRESENTATIONCONTEXT') ?? [])
      .filter((id) => this.dataStore.entityIndex.byId.has(id));
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
  private findUnitId(unitName: string, effective: EffectiveEntityIndex): number | null {
    return this.findLengthUnitReference(this.normalizeMapUnitName(unitName), effective);
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
   * The source STEP text of an entity's line, or `null` when there are no bytes
   * to read.
   *
   * The byte check is on the RANGE, not on `dataStore.source`. `source` is a
   * MANDATORY accessor — `EMPTY_SOURCE_BYTES` is how "this model kept no bytes"
   * is spelled (server-parsed, synthetic, GLB and point-cloud stores all have
   * one) — so the `!this.dataStore.source` guard the five readers below used to
   * carry never fired. It was also redundant: a zero-length range decodes to
   * `''`, which fails every regex those readers run, so they already answered
   * "nothing" for a sourceless store. Scoping the check to the range is what
   * makes the guard live without changing a single answer, the same shape and
   * for the same reason as `reference-collector.ts` (#2339).
   *
   * An OVERLAY-created entity never reaches here: every caller resolves its id
   * through `dataStore.entityIndex.byId`, which holds source records only
   * (`effective-index.ts` synthesises the overlay refs on its own side and
   * writes nothing back), so an overlay id is already `undefined` at the
   * lookup and is served by the callers' documented "not a source record"
   * path. That is why an early return is safe HERE and is NOT safe at the
   * visible-only closure in `export` — see the comment there.
   *
   * ## Why `isReadableSourceRef` and not `byteLength === 0`
   *
   * An out-of-range ref does NOT degrade to "no match" here. `decodeUtf8`
   * clamps the range it cannot address, and the clamped window is still a
   * window over real file bytes — so these readers answer from somebody
   * ELSE's record. `source-ref-bounds.ts` (#2491) carries the measured
   * account of both shapes and of why "a clamped, empty decode already yields
   * no match" is false; it is not restated here, because an argument kept in
   * two files is an argument that has to stay true in two files.
   *
   * The consequence specific to THIS site is that the wrong answer is acted
   * on. `retainSharedAtoms` un-skips every id `getPropertyIdsInSet` returns,
   * so a member list read out of the wrong record un-skips the wrong atoms;
   * and the source-iteration pass already refuses to emit a record whose ref
   * fails `isReadableSourceRef` (see the `continue` in `export`), so before
   * this gate these readers were making decisions on behalf of a container
   * that the same export had decided not to write. Gating them on the same
   * predicate is what makes the two passes agree.
   *
   * The degradation is the one the exporter already handles: a record with no
   * emittable bytes, generating nothing and named by nothing. It costs one
   * answer that used to be right by luck — an overrunning ref on the file's
   * LAST record clamps back to exactly that record's text — but that record
   * is one the emission pass drops anyway, so keeping the answer only kept
   * the disagreement.
   */
  private entityLineText(entityId: number): string | null {
    const entityRef = this.dataStore.entityIndex.byId.get(entityId);
    if (!entityRef || !this.isReadableSourceRef(entityRef)) return null;
    return decodeRange(
      this.dataStore.source,
      entityRef.byteOffset,
      entityRef.byteOffset + entityRef.byteLength
    );
  }

  /**
   * Get entity IDs related by IfcRelDefinesByProperties (the related objects)
   */
  private getRelatedEntities(relId: number): number[] {
    const entityText = this.entityLineText(relId);
    if (entityText === null) return [];

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
    const entityText = this.entityLineText(relId);
    if (entityText === null) return null;

    // Last #ID before the closing );
    const match = entityText.match(/,\s*#(\d+)\s*\)\s*;$/);
    if (!match) return null;
    return parseInt(match[1], 10);
  }

  /**
   * Get the name of a property set by parsing the entity
   */
  private getPropertySetName(psetId: number): string | null {
    const entityText = this.entityLineText(psetId);
    if (entityText === null) return null;

    // Parse: IFCPROPERTYSET('guid',$,'Name',$,...) - Name is 3rd argument
    const match = entityText.match(/IFCPROPERTYSET\s*\([^,]*,[^,]*,'([^']*)'/i);
    if (!match) return null;
    return match[1];
  }

  /**
   * Get the name of an element quantity set by parsing the entity
   */
  private getElementQuantityName(entityId: number): string | null {
    const entityText = this.entityLineText(entityId);
    if (entityText === null) return null;

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
    const entityText = this.entityLineText(psetId);
    if (entityText === null) return [];

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

