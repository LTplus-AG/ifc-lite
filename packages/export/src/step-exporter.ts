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
  type MapConversion,
  type ProjectedCRS,
} from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { RandomSource } from '@ifc-lite/encoding';
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
  type ModificationLedger,
  type SourceLineDelivery,
} from './delta-modification-ledger.js';
import { nominateDeliveredInPlaceEdits } from './in-place-nomination.js';
import { createSourceRefReader, decodeRange } from './source-ref-bounds.js';
import {
  buildRelDefinesByPropertiesIndex,
  collectPropertyAndQuantitySetMutations,
  generatePropertyAndQuantitySetEntities,
  getPropertyIdsInSet,
  type OwnerHistoryCache,
  type PropertySetContext,
} from './step-property-sets.js';
import { applyGeoreferencingMutations, type GeorefContext } from './step-georeferencing.js';
import { getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';
import { HAS_PROPERTY_SETS_SLOT } from './type-owned-psets.js';
import {
  toStepReal,
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
   * `IfcRelDefinesByProperties` links. Without it those come from the platform
   * CSPRNG, so two exports of the same model differ in exactly those bytes -
   * which breaks byte-reproducibility for in-store builds that call
   * `addPropertySet` / `addQuantitySet` (the sets themselves live in the
   * mutation overlay and only become IFC roots here). Pass the same seeded
   * source used for `SpatialAnchor.guidRandom` to close that gap. Default
   * (omitted) behaviour for THESE ids is unchanged: random.
   *
   * NOT the `IFCPROXY` placeholders any more (#2733). Those used to be minted
   * from this source too, so an omitted `guidRandom` made every downgraded
   * IFC4X3 entity differ on re-export. They are now derived from the source
   * line when this is omitted, and only fall back to this source when it is
   * supplied - so passing a seeded source still pins them, but NOT passing one
   * no longer makes them random. See `convertStepLine`.
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
     * A requested `georefMutations.mapConversion` is one case: with no
     * `IfcGeometricRepresentationContext` to reference as `SourceCRS`, the
     * `IfcMapConversion` is skipped (writing it would produce a dangling
     * reference) while the `IfcProjectedCRS` is still written — so the output
     * is indistinguishable from "no map conversion was requested" unless the
     * caller reads this (#2067).
     *
     * A WITHHELD RELATIONSHIP is the other: when a relationship names an
     * entity this export is not writing, in a slot with no spelling for an
     * omitted reference, the whole relationship line is dropped rather than
     * shipped dangling — see {@link relationshipWithheldWarning}. This can
     * happen on a plain full export with no options set at all, so it is
     * reported rather than left to be discovered by a diff.
     *
     * Same `string[]` shape as `MergeExportResult.stats.warnings`.
     */
    warnings: string[];
  };
}

/**
 * Message for a relationship this export DROPPED rather than rewrote.
 *
 * `filterHiddenRefsFromRelationshipLine` removes an omitted `#N` from a
 * SET/LIST attribute, but a single-valued attribute has no STEP spelling for
 * "omitted" and an empty SET is not the same statement as the original — so in
 * both of those cases it withholds the whole line and the relationship simply
 * is not in the output. Withholding beats shipping a dangling `#N`, but it is
 * not free: every OTHER entity that relationship named loses the association.
 * A visible element can therefore come out of a plain full export with one
 * fewer pset than it went in with, and before this warning existed nothing in
 * the result said so (adversarial review of #2668).
 *
 * Deliberately reports the relationship rather than the omitted target: the
 * target's own omission is already the caller's own doing in every reason but
 * the unreadable-ref one, whereas the lost association is the surprise.
 */
const relationshipWithheldWarning = (expressId: number, type: string): string =>
  `Relationship #${expressId} (${type}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted). Anything else that relationship associated is no longer associated in the output.`;

/**
 * What {@link StepExporter.applySourceLineMutations} produced: the rewritten
 * line, plus which edit kinds that rewrite actually delivered. The delivery
 * half is {@link SourceLineDelivery} rather than three loose booleans so that
 * the pipeline and the ledger cannot disagree about what a source line carries
 * — an added kind has one place to be added.
 */
export type SourceLineMutations = SourceLineDelivery & { text: string };

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
 *    `isRefExcludedDuringClosureWalk`) exist precisely so two phases cannot
 *    disagree about a gate — see the comments at their construction sites for
 *    the corrupt files the earlier, per-phase versions let through (#2491,
 *    #2414, #2398, #2637). A phase that reimplements one of these instead of
 *    reading it off the pass reintroduces exactly that class of defect.
 * 2. **`allowedEntityIds` and `hiddenProductIds` are mutable, and the
 *    predicates close over the pass rather than over a snapshot.** The
 *    visible-only closure walk assigns both AFTER construction, and
 *    `isRefExcludedDuringClosureWalk` is handed to that walk while they are
 *    still null. The output-line filter reads them too, through
 *    `isOmittedFromOutput` -> `willBeEmitted`, so neither can be a snapshot
 *    taken before the walk ran — that is the invariant the #2637 regression
 *    broke.
 *
 * Deliberately NOT on the pass, and why: `isOmittedFromOutput`,
 * `mayNameOmittedRefs` and
 * `overlayNewEntityCount` are eagerly-computed values whose value is only
 * defined after work that runs past this construction site, so hoisting them
 * would change what they compute rather than where they are named;
 * `generatedTypeOwnedPsetIds` is read in one phase only — a local inside
 * `step-property-sets.ts:generatePropertyAndQuantitySetEntities`, which holds
 * both the loop that writes it and the loop that reads it (#2475).
 */
export interface ExportPass {
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
  readonly isRefExcludedDuringClosureWalk: (id: number) => boolean;
}

/**
 * IFC STEP file exporter
 */
export class StepExporter {
  private dataStore: IfcDataStore;
  private mutationView: MutablePropertyView | null;
  private nextExpressId: number;
  private entityExtractor: EntityExtractor | null;
  /**
   * The owner-history memos the property-set and quantity-set generators read.
   *
   * Owned here and handed to `step-property-sets.ts` BY REFERENCE rather than
   * stored on its context: the reset below is an `export()`-level statement,
   * and the comment there is where "per export, not per exporter" is argued.
   * Moving the storage into a per-export context would make that reset
   * implicit — the same invariant, in a place nothing says it (#2475 step 2b).
   */
  private ownerHistory: OwnerHistoryCache = { fallbackRef: undefined, byEntity: new Map() };
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
    this.ownerHistory.fallbackRef = undefined;
    this.ownerHistory.byEntity.clear();

    // Determine target schema from options, source schema from data store
    const schema = options.schema || (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const sourceSchema = (this.dataStore.schemaVersion as IfcSchemaVersion) || 'IFC4';
    const converting = needsConversion(sourceSchema, schema);

    // Read ONCE, here, and consumed everywhere below instead of re-spelling
    // `options.applyMutations !== false` per site. `options` is the caller's
    // object and this export re-enters it dozens of times; an accessor that
    // answered differently on the second read would have let the effective
    // index be built WITH the overlay while a later guard — including the
    // relationship-filter precondition — decided there was none. Reading each
    // option that feeds that precondition exactly once makes the two agree by
    // construction rather than by every site happening to spell it the same
    // way (adversarial review of #2668's replacement gate).
    const applyMutations = options.applyMutations !== false;
    // Same, for the other option the precondition reads. `isGeometryExcluded`
    // below and both output passes' own geometry skips consume this one const,
    // so "the gate thinks geometry is included while the predicate thinks it is
    // excluded" is not a state this export can reach.
    const excludeGeometry = options.includeGeometry === false;

    if (
      schema === 'IFC2X3' &&
      applyMutations &&
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
      overlayActive: !!this.mutationView && applyMutations,

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
        applyMutations,
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
      // just excluded out of the relationship's own attribute list. Kept because
      // the closure walk's `isRefExcludedDuringClosureWalk` needs a notion of
      // "hidden" that does not read `allowedEntityIds` — the set that walk is
      // producing (#2398). The two OUTPUT passes no longer read this directly:
      // they filter on `isOmittedFromOutput`, which subsumes it via
      // `allowedEntityIds`.
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
      // `collectReferencedEntityIds` as its `isRefExcluded` — rather than the
      // walk inventing its own `!entityIndex.has` proxy for "deleted" that could
      // disagree on an id that never existed in the file at all
      // (maintainer-found regression on #2637: such an id blocked the bridge but
      // did not stop the relationship's own line from shipping, dropping a
      // VISIBLE sibling's pset while adding a fresh dangling ref). A closure over
      // `pass.hiddenProductIds`, not a value snapshot — correct because nothing
      // reads it before the closure walk assigns it just below.
      //
      // ## Why this is NOT the predicate the OUTPUT-line filter uses
      //
      // The name says walk, and only walk. The two passes that write a
      // relationship's line ask `isOmittedFromOutput` (further below, derived
      // from `pass.willBeEmitted`), which is strictly stronger — it also answers
      // for the closure, for an unreadable source ref and for a geometry
      // exclusion.
      //
      // This one CANNOT be `willBeEmitted`, and the difference is structural
      // rather than stylistic: `willBeEmitted`'s first act is to consult
      // `allowedEntityIds`, and `allowedEntityIds` is precisely what the call
      // below is computing. Wiring it in here is circular: it would answer "not
      // in the closure" as `false` while the closure is still being built and
      // `true` for the same id afterwards.
      //
      // That is a genuine departure from the contract #2637 was closed on —
      // `reference-collector.ts` still documents the bridge as taking the
      // caller's OWN output predicate, "not two expressions that happened to
      // agree". It has an OBSERVABLE consequence, not just a naming one: for an
      // unreadable source ref this admits, the walk bridges through a
      // relationship the output then withholds, leaving the relationship's other
      // target in the closure with nothing naming it — an orphan, pinned by
      // `unreadable-ref-dangling.test.ts` ("walk and output predicates diverge").
      // The reverse direction is closed: every id this excludes,
      // `isOmittedFromOutput` excludes too, so the #2548 leak cannot return.
      isRefExcludedDuringClosureWalk: (id: number): boolean =>
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
        excludeGeometry
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
        pass.isRefExcludedDuringClosureWalk,
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

    /**
     * "Does this model hold a record whose bytes this export cannot read?" —
     * the one disjunct of {@link mayNameOmittedRefs} that is not already a
     * value in hand, so it is a function and called last, behind `||`.
     *
     * Scans the EFFECTIVE index, and that is a requirement rather than an
     * implementation detail: it has to cover the id space
     * `isOmittedFromOutput` answers over, and an unreadable record can live in
     * `deferredEntityIndex` — the secondary index `getCompleteEntityIndex`
     * exists to merge — and nowhere in `entityIndex.byId`. Scanning `byId`,
     * the obvious cheaper source, was measured to leave the gate false and
     * ship the dangling ref; `relationship-filter-gate.test.ts` pins the
     * merged scan behaviourally so that shortcut cannot come back as an
     * optimisation.
     *
     * Reads the ref ITERATION yields — what the source-iteration pass's own
     * skip reads — rather than re-asking `effective.get(id)` per id as
     * `willBeEmitted` does, which on the largest files would cost a binary
     * search and an allocation per entity and defeat the point of the gate.
     * Every index here keeps the two in step by construction:
     * `CompactEntityIndex` serves `get`, `has` and iteration from one pair of
     * `Uint32Array`s, a `Map` trivially agrees, the merged deferred view is
     * `byId.get ?? deferred.get` over `yield* byId; yield* deferred`, and
     * `OverlayIndex` filters both by one tombstone set. An index whose `has`
     * accepted an id its iteration never yields would defeat this — and would
     * equally defeat the source-iteration pass's skip, so that file is broken
     * either way; nothing in the repo builds one.
     *
     * Not short-circuited on `overlayActive`: an overlay-created record carries
     * `(OVERLAY_BYTE_OFFSET, 0)` and so counts as unreadable here, which would
     * make this always answer true once an overlay exists. Harmless —
     * `overlayActive` is an earlier disjunct, so this never runs then — and
     * correct if it ever did.
     *
     * ## Why a standalone pass rather than a value off the index
     *
     * Measured: 12.0 ms of a 470 ms export at 714,485 entities (2.55%), one
     * call, whole index walked because a well-formed model gives it nothing to
     * short-circuit on. The cheaper shape was prototyped and is 13x faster —
     * `min(byteLength)` and `max(byteOffset + byteLength)` over
     * `CompactEntityIndex`'s own `Uint32Array`s answer "is every ref readable
     * within `extent`" exactly and allocation-free in 0.74 ms — and was not
     * taken, because 11 ms does not buy what it costs.
     *
     * It could only stand in FRONT of this loop, never replace it:
     * `EntityByIdIndex` is a structural type and plain `Map`s satisfy it
     * (`synthetic-data-store.ts` builds one), so the walk stays for those. That
     * makes it a second implementation of one predicate across a package
     * boundary — the defect class #2637, #2668 and this gate are all instances
     * of. And storing it at construction is the invariant
     * `source-ref-bounds.ts` exists to delete: `CompactEntityIndex` is built by
     * its builder, by `compactEntityIndexFromColumns` in the transport, and by
     * embedders, so a value one producer writes is a value the next can skip,
     * whereas testing the ref where it is READ cannot be bypassed. If 2.5% ever
     * has to go, the safe shape is a memoized derivation the index computes
     * from its own arrays on demand — not a field set at build time.
     */
    const hasAnyUnreadableSourceRef = (): boolean => {
      for (const [, ref] of pass.effective) {
        if (!pass.isReadableSourceRef(ref)) return true;
      }
      return false;
    };


    // Process mutations if we have a mutation view
    if (this.mutationView && applyMutations) {
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
      const { byEntity: relDefinesByEntity, relatedByRel } = buildRelDefinesByPropertiesIndex(this.propertySetContext());

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

      collectPropertyAndQuantitySetMutations(
        pass,
        options,
        { entityPropMutations, entityQuantMutations, relDefinesByEntity },
        this.propertySetContext(),
      );

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
    if (applyMutations && options.georefMutations) {
      applyGeoreferencingMutations(pass, options.georefMutations, this.georefContext(options.deltaOnly === true));
    }

    // If delta only, only export modified entities. Overlay-created entities
    // also count — without this, `createEntity()`-only edits would silently
    // drop out of delta exports.
    const overlayNewEntityCount = (
      this.mutationView
      && applyMutations
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


    /**
     * "May a line this export writes name `#id`?" — the single predicate both
     * relationship-line filter sites consume, derived from `willBeEmitted`
     * rather than from a second list kept in step with it by hand.
     *
     * DERIVED, not identical, and the gaps are named below rather than glossed:
     * a scope qualifier for ids the file never had, and `deltaOnly`, where
     * `willBeEmitted` answers `true` for a source record whose line this export
     * does not write at all (the source-iteration pass is skipped wholesale in
     * that mode). Nor does this make the CLOSURE WALK agree with either: the
     * walk keeps `isRefExcludedDuringClosureWalk` and diverges from this
     * predicate for an unreadable source ref — see the note on that predicate,
     * and the "walk and output predicates diverge" test.
     *
     * The hand-kept second list is the bug this replaces. `willBeEmitted` recognises
     * seven reasons a line never lands — outside the closure, hidden product,
     * tombstoned, never existed, unreadable source ref (#2491), geometry
     * excluded by options, and the `deltaOnly` carve-out — while the filter
     * used to consume `(hiddenProductIds !== null && hiddenProductIds.has(id))
     * || effective.isDeleted(id)`, which answered for two: hidden product, and
     * tombstoned. Notably NOT "never existed" — that one is deliberately out of
     * scope for the filter even now, for the reason under the qualifier heading
     * below. The gap was live: on a PLAIN full export, with no `visibleOnly`,
     * no deletions and no overlay, an unreadable ref made the source-iteration
     * pass skip an entity's line while an `IFCREL*` naming it shipped verbatim,
     * dangling.
     *
     * Deriving the filter from `willBeEmitted` is also what fixed the
     * `mayNameExcludedRefs` gate that stands in front of both call sites. That
     * gate used to be a SECOND, shorter enumeration of the same reasons
     * (hidden products exist, or an overlay is active) and answered `false` for
     * exactly the unreadable-ref export above, so the filter never ran at all.
     * It is now {@link mayNameOmittedRefs} — see there for why a gate is kept
     * at all (running the filter on every `IFCREL*` line costs +13% of a
     * 714k-entity export) and for the enumeration it has to cover.
     *
     * ## The one qualifier on top of `willBeEmitted`
     *
     * `willBeEmitted` answers NO for an id neither the file nor the session
     * ever had, which is right for its own job — nothing GENERATED may name an
     * id that does not exist. It is the wrong answer for rewriting a SOURCE
     * line, and the difference is whose bug it is. A `#999` already sitting in
     * a relationship's `OwnerHistory` slot in the input file is a dangling ref
     * this export did not create and cannot repair; `filterHiddenRefsFromRelationshipLine`
     * withholds a whole relationship when an excluded id is in a bare scalar,
     * so treating it as an exclusion would DELETE a visible element's pset over
     * somebody else's corrupt file. That is the harm #2637 was about, and
     * `step-exporter.test.ts` states the position out loud: a pre-existing
     * dangling ref is out of scope and ships as it arrived.
     *
     * So the filter asks the narrower question: is `#id` an entity this model
     * HAS, that this export is nonetheless not writing? `effective.has` is
     * false for a tombstone, hence the explicit `isDeleted` arm — deleting an
     * entity IS this session's doing and must be filtered.
     *
     * This is a scope qualifier, not a second enumeration of omission reasons:
     * an eighth reason added to `willBeEmitted` still reaches the filter with
     * no edit here.
     *
     * ## What the filter can and cannot reach
     *
     * Only `IFCREL*` lines. A `#N` named from a product's `Representation` or
     * `ObjectPlacement` slot is not touched, so `includeGeometry:false` — a
     * reason `willBeEmitted` does answer for — produces the same dangling refs
     * with this predicate as without it. Measured on `tests/models/AB22.ifc`:
     * 80 dangling refs before and after, output byte-identical but for the
     * header timestamp.
     *
     * ## Withholding is not free
     *
     * When the omitted id sits in a single-valued slot, or is a set's only
     * member, `filterHiddenRefsFromRelationshipLine` withholds the WHOLE
     * relationship — so an entity that relationship also named loses the
     * association, on a plain full export with no options set. That is why the
     * call sites push {@link relationshipWithheldWarning}.
     *
     * See `unreadable-ref-dangling.test.ts` for the reproduction. #2637 is the
     * prior instance of this class, which took seven rounds because the same
     * decision was recomputed per call site.
     */
    const isOmittedFromOutput = (id: number): boolean =>
      (pass.effective.has(id) || pass.effective.isDeleted(id)) && !pass.willBeEmitted(id);

    /**
     * "Can ANY id be omitted from this export at all?" — the precondition both
     * `IFCREL*` filter sites are gated on, so the common export pays nothing.
     *
     * ## Why a gate exists
     *
     * Running `filterHiddenRefsFromRelationshipLine` on every `IFCREL*` line
     * costs a re-parse of that line's attribute list, and a large model is
     * mostly relationships. Measured on `tests/models/ara3d/schependomlaan.ifc`
     * (714,485 entities, 21 interleaved reps in randomised order): 463 ms
     * median with this gate false versus 523 ms filtering unconditionally,
     * **+13%**. That is a real price paid on every export to protect a state
     * most exports are not in. With the gate, the same export is 475 ms, +2.7%,
     * all of it the fourth disjunct's one pass.
     *
     * ## Why THIS gate, and not the one that shipped before
     *
     * The gate this replaces was a second, hand-kept enumeration of "reasons an
     * entity might be excluded", and it went stale exactly as such lists do: it
     * named hidden products and the overlay and knew nothing about an unreadable
     * source ref, so the bug this branch fixes reached the output with the
     * filter switched off. A cheap gate is safe only as an OVER-APPROXIMATION of
     * `isOmittedFromOutput` that can be checked against `willBeEmitted` branch
     * by branch — so every branch is listed, with the disjunct that covers it:
     *
     * | `willBeEmitted` answers NO at                | covered by                    |
     * |----------------------------------------------|-------------------------------|
     * | `allowedEntityIds !== null && !has(id)`      | `allowedEntityIds !== null`   |
     * | `!ref`, because the overlay tombstoned `id`  | `overlayActive`               |
     * | overlay-created, geometry excluded           | `overlayActive`               |
     * | `!isReadableSourceRef(ref)`                  | `hasAnyUnreadableSourceRef()` |
     * | source-backed, geometry excluded             | `excludeGeometry`             |
     * | `!ref`, because `id` never existed           | out of scope (below)          |
     * | `!ref` while `has(id)` is TRUE               | nothing (below)               |
     *
     * "Never existed" needs no disjunct: `isOmittedFromOutput`'s own
     * `(has || isDeleted)` qualifier already drops it, deliberately — a
     * pre-existing dangling ref in somebody else's file is not this export's to
     * repair (see that predicate's note).
     *
     * The last row is a real hole and is stated rather than hidden: an index
     * that answers `has(id)` for an id its iteration never yields makes
     * `isOmittedFromOutput` true with no disjunct true. It needs an index whose
     * `has`, `get` and iteration disagree, which nothing in the repo builds and
     * which would already break the source-iteration pass's own skip — see
     * {@link hasAnyUnreadableSourceRef}, which rests on the same agreement.
     *
     * Three of the four disjuncts are reads of values this export already
     * computed. Only the fourth costs anything, and it short-circuits: `||`
     * evaluates it solely when the other three are false, i.e. only for an
     * export that has nothing else to filter for.
     *
     * ## The two spellings that are deliberately NOT the obvious ones
     *
     * `allowedEntityIds !== null`, not `options.visibleOnly === true`. Not the
     * same test: the closure is built under `if (options.visibleOnly &&
     * this.dataStore.source)`, which is TRUTHY rather than `=== true`, and which
     * is a SECOND read of the caller's object. A plain-JS caller of this
     * published package passing `visibleOnly: 1` — or a `get visibleOnly()` that
     * answers `true` once — built the closure while the gate read false and
     * shipped a relationship naming an entity outside it. Executed, not
     * reasoned: 192 of an 800-case sweep over `visibleOnly`/`hidden`/`isolated`
     * combinations shipped a dangling ref against the `=== true` spelling, 0
     * against this one. Reading the state the walk PRODUCED cannot disagree with
     * the walk, whatever `options` says afterwards.
     *
     * It is also wider than the `hiddenProductIds.size > 0` the old gate used: a
     * closure exists whenever `visibleOnly` was requested, even with nothing
     * hidden, and can exclude an entity the roots simply never reach. No fixture
     * has produced that case, so the widening is defensive — but a gate that is
     * true too often costs speed on a rare path, while one that is false too
     * rarely ships a corrupt file, and this one costs nothing.
     *
     * `overlayActive` and `excludeGeometry` are the SAME consts the effective
     * index and `isGeometryExcluded` are built from — one read of `options` per
     * question, shared — so those two cannot disagree with the predicate either.
     */
    const mayNameOmittedRefs =
      pass.allowedEntityIds !== null
      || pass.overlayActive
      || excludeGeometry
      || hasAnyUnreadableSourceRef();

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

        // Skip geometry if not included. Classified via `isGeometryExcluded`
        // (which reads the EFFECTIVE type, `effective.effectiveType`) rather
        // than `entityRef.type` directly: a retype can move a record across
        // the geometry boundary in either direction, and this check has to
        // agree with `hasEmittableHostBytes`/`willBeEmitted`'s use of the
        // same predicate — otherwise a wall retyped to `IfcCartesianPoint`
        // still ships its (rewritten) geometry line under
        // `includeGeometry: false`, the exact "predicate must agree" failure
        // this file already guards for the non-retyped case (#2414).
        if (pass.isGeometryExcluded(expressId, entityRef.type)) {
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
          (attr, value) =>
            pass.warnings.push(
              `entity #${expressId}: attribute ${attr} not written - ` +
                `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
            ),
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
        // the source's authored type: a retype can move a record across
        // the `IFCREL*` boundary in either direction (`applySourceLineMutations`
        // already rewrote `nextEntityText` to the new class), and this check
        // has to agree with what actually got written, the same way
        // `getVisibleEntityIds` already does for the visibility walk itself.
        const effectiveRelType = pass.effective.effectiveType(expressId, entityRef.type).toUpperCase();
        if (mayNameOmittedRefs && effectiveRelType.startsWith('IFCREL')) {
          const filtered = filterHiddenRefsFromRelationshipLine(nextEntityText, isOmittedFromOutput);
          if (filtered === null) {
            pass.warnings.push(relationshipWithheldWarning(expressId, effectiveRelType));
            continue;
          }
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

    // Generated property/quantity sets and the type-object `HasPropertySets`
    // rewrite that resolves against them, in that one order (#2475 steps 2b
    // and 2c). `pass.rewrittenEntityLines`, this call's output, is flushed
    // just below — after the quantity-set loop inside it, as it always was.
    generatePropertyAndQuantitySetEntities(pass, options, this.propertySetContext());

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
      && applyMutations
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
        if (excludeGeometry && this.isGeometryEntity(upperType)) {
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
            // Overlay-created entities report a rejected REAL edit exactly as
            // source-backed ones do. Without this the slot was kept and NOTHING
            // was said - the silent discard this whole change exists to
            // prevent, surviving in the one path that had no test.
            (attr, value) =>
              pass.warnings.push(
                `entity #${entity.expressId}: attribute ${attr} not written - ` +
                  `${JSON.stringify(value)} is not a number and the slot is REAL-typed`,
              ),
          );
        }
        let line: string | null = `#${entity.expressId}=${upperType}(${argsText});`;
        // Same gap as the source-iteration pass, for an overlay-authored
        // relationship instead of a parsed one (#2398).
        //
        // `mayNameOmittedRefs` is provably TRUE wherever this line executes:
        // the block enclosing this pass requires `this.mutationView` and
        // `applyMutations`, which is `pass.overlayActive`, which is one of the
        // gate's own disjuncts. Spelled out anyway so both filter sites read the
        // same — the previous gate's failure was one site's condition drifting
        // from what the filter needed, and a pass reachable without an overlay
        // would otherwise silently need the gate re-derived here.
        if (mayNameOmittedRefs && upperType.startsWith('IFCREL')) {
          line = filterHiddenRefsFromRelationshipLine(line, isOmittedFromOutput);
          if (line === null) {
            pass.warnings.push(relationshipWithheldWarning(entity.expressId, upperType));
            continue;
          }
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
    onRejected?: (attrName: string, value: string) => void,
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
      text = this.applyAttributeMutations(
        text,
        workingType,
        attributeMutations,
        sourceSchema,
        onRejected,
      );
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
    schemaVersion: IfcSchemaVersion,
    onRejected?: (attrName: string, value: string) => void,
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
    const realSlots = getRealTypedSlots(entityType, schemaVersion);

    for (const [attrName, value] of attributeMutations) {
      const index = attrNames.indexOf(attrName);
      if (index < 0 || index >= args.length) continue;
      // The source path shares every `$`-slot hole with the overlay-created
      // path, because a source record has plenty of `$` slots of its own. Both
      // go through the one helper below.
      const serialized = this.serializeNamedAttribute(
        entityType,
        index,
        value,
        args[index],
        realSlots,
      );
      if (serialized === null) {
        // Slot untouched AND reported. Not counted as a change: claiming a
        // modification we did not make is the failure this avoids.
        onRejected?.(attrName, value);
        continue;
      }
      args[index] = serialized;
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
   *
   * Before this REAL check existed, "the declared type decides first" was true
   * for enum/string slots only — a REAL-backed slot (`IfcMapConversion.
   * OrthogonalHeight`, any other `IfcLengthMeasure`/`IfcReal`-typed attribute)
   * fell straight to `serializeAttributeValue`'s token inference, which quotes
   * anything it cannot recognize as numeric. A schema-legal `$` placeholder
   * carries no digits to recognize, so setting such a field for the first time
   * wrote `'12345'` in a slot ISO 10303-21 requires to be an unquoted REAL —
   * silently invalid output (#2724, LTplus-AG/ifc-lite#2475).
   */
  private serializeNamedAttribute(
    entityType: string,
    index: number,
    value: string,
    currentToken: string,
    realSlots: ReadonlySet<number>,
  ): string | null {
    if (getEnumTypedSlots(entityType).has(index)) return serializeEnumToken(value);
    if (getStringTypedSlots(entityType).has(index)) return serializeStringSlot(value);
    if (realSlots.has(index)) {
      const trimmed = value.trim();
      if (trimmed === '') return '$';
      const numberValue = Number(trimmed);
      if (Number.isFinite(numberValue)) return toStepReal(numberValue);
      // A non-numeric value in a REAL slot used to fall through and be QUOTED,
      // producing the same ISO 10303-21 violation #2725 exists to prevent
      // (#2741). `StoreEditor.setAttribute` takes a string, so any UI text
      // field bound to a georeferencing REAL can deliver one; it does not need
      // a corrupt file.
      //
      // `null` means "leave the slot as the file had it". Simply returning
      // `currentToken` here would stop the invalid output but SILENTLY DISCARD
      // the edit - the exporter would then claim a modification it did not
      // carry, which is the exact misreport #2723/#2724/#2726 were written to
      // pin. The caller turns this into a warning, so a dropped edit is visible
      // rather than inferred from absence.
      return null;
    }
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
    onRejected?: (attrName: string, value: string) => void,
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
    const realSlots = getRealTypedSlots(entityType, schemaVersion);
    for (const [index, value] of named) {
      const serialized = this.serializeNamedAttribute(
        entityType,
        index,
        value,
        args[index],
        realSlots,
      );
      // Overlay-created entities take the same rejection: a non-numeric REAL is
      // invalid STEP whoever authored the record. The slot keeps the `$` this
      // path padded it with, rather than gaining a quoted string.
      if (serialized === null) {
        onRejected?.(attrNames[index] ?? `#${index}`, value);
        continue;
      }
      args[index] = serialized;
    }

    if (positionalOverrides && positionalOverrides.size > 0) {
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

  /**
   * Find the maximum EXPRESS ID in the data store
   */
  private findMaxExpressId(): number {
    // Span deferred property atoms too, so newly allocated ids can't collide
    // with a deferred entity sitting at a higher express id than anything in byId.
    return getMaxExpressId(getCompleteEntityIndex(this.dataStore));
  }

  /**
   * The exporter state `step-georeferencing.ts` cannot read off the pass.
   *
   * `allocateExpressId` hands out ids from THIS exporter's `nextExpressId`,
   * which the property-set and quantity-set generators in
   * `step-property-sets.ts` increment at six further sites through the same
   * callback — hoisting the counter onto the pass would change what it
   * computes, not merely where it is named, so both phases get a callback
   * instead (#2475 step 2a).
   */
  private georefContext(deltaOnly: boolean): GeorefContext {
    return {
      dataStore: this.dataStore,
      entityExtractor: this.entityExtractor,
      allocateExpressId: () => this.nextExpressId++,
      deltaOnly,
    };
  }

  /**
   * The state `step-property-sets.ts` cannot read off the pass (#2475 2b/2c).
   *
   * `allocateExpressId` is the same callback `georefContext` hands out, over
   * the same counter, so the ids the two phases allocate stay in one sequence.
   * `ownerHistory` is passed by reference — the object is this exporter's, and
   * `export()` resets it. `isReadableSourceRef` is the instance predicate, not
   * `pass.isReadableSourceRef`, because two consumers of that module
   * (`buildRelDefinesByPropertiesIndex`, `retainSharedAtoms`) run with no pass
   * in hand; both readers are built over the same source.
   *
   * Rebuilt per call, as `georefContext` is: every call site runs once per
   * export bar `retainSharedAtoms`, which hoists it out of its loop.
   */
  private propertySetContext(): PropertySetContext {
    return {
      dataStore: this.dataStore,
      entityExtractor: this.entityExtractor,
      mutationView: this.mutationView,
      isReadableSourceRef: this.isReadableSourceRef,
      allocateExpressId: () => this.nextExpressId++,
      ownerHistory: this.ownerHistory,
      applySourceLineMutations: (expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected) =>
        this.applySourceLineMutations(expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected),
    };
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
    // Built once for the whole sweep rather than per container: the readers in
    // `step-property-sets.ts` take the context, and this loop calls one of them
    // once per IfcPropertySet / IfcElementQuantity in the file.
    const ctx = this.propertySetContext();
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
      for (const atomId of getPropertyIdsInSet(ctx, containerId)) {
        skipIds.delete(atomId);
      }
    }
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
