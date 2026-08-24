/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC STEP file exporter
 *
 * Exports IFC data store to ISO 10303-21 STEP format.
 * Supports applying property and root attribute mutations before export.
 */

import type { IfcDataStore, IfcSourceHeader } from '@ifc-lite/parser';
import { EntityExtractor, parseSourceHeader } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { needsConversion, type IfcSchemaVersion } from './schema-converter.js';
import { getCompleteEntityIndex, getMaxExpressId } from './entity-iteration.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import {
  writeSourceEntityLines,
  type SourceIterationContext,
} from './step-source-iteration.js';
import {
  writeOverlayCreatedEntities,
  type OverlayEntitiesContext,
} from './step-overlay-entities.js';
import {
  generatePropertyAndQuantitySetEntities,
  type OwnerHistoryCache,
  type PropertySetContext,
} from './step-property-sets.js';
import { type GeorefContext } from './step-georeferencing.js';
import { collectModifications, type CollectionContext } from './step-collection.js';
import { assembleExportResult } from './step-header.js';
import {
  applySourceLineMutations,
  applyOverlayEntityOverrides,
} from './step-attribute-mutations.js';

/**
 * The export vocabulary lives in `step-export-types.ts` (#2475). Re-exported
 * here, unchanged, so that the package entry point and the seven sibling
 * modules that import `ExportPass` / `SourceLineMutations` from this file
 * carry on doing exactly that -- the split moved declarations, not call sites.
 */
export type {
  StepExportOptions,
  StepExportProgress,
  StepExportResult,
  SourceLineMutations,
  ExportPass,
} from './step-export-types.js';
// Only the three this file's own body still names. `StepExportProgress` and
// `SourceLineMutations` are re-exported above but never referenced here, and
// importing them too raises TS6196 under --noUnusedLocals.
import type { StepExportOptions, StepExportResult, ExportPass } from './step-export-types.js';
import { relationshipWithheldWarning } from './step-export-types.js';
import { buildExportPass } from './step-pass-builder.js';


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
    // seven phases, built in `step-pass-builder.ts` (#2475). `ExportPass` in
    // `step-export-types.ts` says what belongs on it and what deliberately
    // does not.
    //
    // What comes back is the object the phases below MUTATE -- notably
    // `collectModifications`, which fills in the `allowedEntityIds` /
    // `hiddenProductIds` that the pass's own predicates close over. Do not
    // copy it; `step-pass-builder.test.ts` is what stops that.
    const pass: ExportPass = buildExportPass({
      dataStore: this.dataStore,
      mutationView: this.mutationView,
      isGeometryEntity: (type) => this.isGeometryEntity(type),
      options,
      schema,
      sourceSchema,
      converting,
      applyMutations,
      excludeGeometry,
      sourceHeader,
      schemaToken,
    });

    // Visible-only closure, overlay mutation grouping, and georeferencing
    // edits — everything `pass` needs before the output passes below can run
    // (#2475, the collection block). See `step-collection.ts` for why
    // `hasAnyUnreadableSourceRef` and the predicates just past it stay here
    // instead of moving with it.
    collectModifications(pass, options, applyMutations, this.collectionContext());

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

    // Write every source-backed record this export keeps (#2475 step 2d),
    // preceded — inside that call — by the shared-atom retention that decides
    // which member atoms the skip sets may still drop.
    writeSourceEntityLines(pass, options, mayNameOmittedRefs, isOmittedFromOutput, this.sourceIterationContext());

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

    // Add overlay-created entities (store.addEntity / mutationView.createEntity),
    // applying the same filters as the source-iteration pass (#2475 step 2e).
    writeOverlayCreatedEntities(
      pass,
      options,
      excludeGeometry,
      applyMutations,
      mayNameOmittedRefs,
      isOmittedFromOutput,
      this.overlayEntitiesContext(),
    );

    // Settle the ledger, build the header, assemble the finished bytes —
    // `step-header.ts` (#2475 header/assembly tail).
    return assembleExportResult(pass);
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
   * (`buildRelDefinesByPropertiesIndex`, and `retainSharedAtoms` in
   * `step-source-iteration.ts`) run with no pass in hand; both readers are
   * built over the same source.
   *
   * Rebuilt per call, as `georefContext` is: every call site runs once per
   * export bar `retainSharedAtoms`, which hoists it out of its loop — hence
   * {@link sourceIterationContext} takes this as a thunk rather than a value.
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
        applySourceLineMutations(this.mutationView, expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected),
    };
  }

  /**
   * The state `step-collection.ts` cannot read off the pass (#2475, the
   * collection block). `propertySetContext` and `georefContext` are handed
   * over as the SAME thunks {@link propertySetContext} and
   * {@link georefContext} already are — this phase calls the first twice per
   * export and the second once, and nothing here should change how often
   * either is rebuilt.
   */
  private collectionContext(): CollectionContext {
    return {
      dataStore: this.dataStore,
      mutationView: this.mutationView,
      propertySetContext: () => this.propertySetContext(),
      georefContext: (deltaOnly) => this.georefContext(deltaOnly),
    };
  }

  /**
   * The state `step-source-iteration.ts` cannot read off the pass (#2475 2d).
   *
   * No `allocateExpressId`: that phase never allocates an id, it only rewrites
   * lines that already have one. `applySourceLineMutations` (#2475, remaining
   * private helpers: now a free function in `step-attribute-mutations.ts`,
   * closed over `this.mutationView` here) and `isGeometryEntity` are injected
   * rather than read off the pass because each has readers outside this
   * phase — the mutation pipeline is shared with the type-object
   * `HasPropertySets` rewrite (see {@link propertySetContext}) and with the
   * overlay-created-entities block in `export()`; `isGeometryEntity` with the
   * visible-only setup closure and that same block.
   */
  private sourceIterationContext(): SourceIterationContext {
    return {
      dataStore: this.dataStore,
      applySourceLineMutations: (expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected) =>
        applySourceLineMutations(this.mutationView, expressId, entityText, recordType, attributeMutations, sourceSchema, overlayActive, onRejected),
      isGeometryEntity: (type) => this.isGeometryEntity(type),
      propertySetContext: () => this.propertySetContext(),
      relationshipWithheldWarning,
    };
  }

  /**
   * The state `step-overlay-entities.ts` cannot read off the pass (#2475
   * step 2e). `applyOverlayEntityOverrides` is now the free function
   * `step-attribute-mutations.ts` exports (#2475, remaining private
   * helpers) — it and its two `serializeNamedAttribute` /
   * `serializePositionalOverride` helpers moved together, since those two
   * have no reader outside this cluster; `isGeometryEntity` and
   * `relationshipWithheldWarning` are the same shared readers
   * {@link sourceIterationContext} already injects into the other output
   * pass.
   */
  private overlayEntitiesContext(): OverlayEntitiesContext {
    return {
      mutationView: this.mutationView,
      applyOverlayEntityOverrides,
      isGeometryEntity: (type) => this.isGeometryEntity(type),
      relationshipWithheldWarning,
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
