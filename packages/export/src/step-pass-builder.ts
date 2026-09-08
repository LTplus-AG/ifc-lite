/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Builds the `ExportPass` one `export()` call threads through its phases.
 *
 * Split out of `step-exporter.ts` for #2475. The literal moved verbatim; the
 * only edits are that the three things it used to read off the exporter
 * (`dataStore`, `mutationView`, `isGeometryEntity`) now arrive as fields of
 * {@link PassBuildInput}.
 *
 * ONE RULE GOVERNS THIS FILE, and it is easy to break by tidying. The
 * predicates below are closures over `pass` ITSELF, and `pass.allowedEntityIds`
 * / `pass.hiddenProductIds` are still `null` when this function returns --
 * `collectModifications` assigns them afterwards, on this very object. So this
 * must `return pass` and nothing else. A spread, a `structuredClone`, an
 * `Object.freeze`, or a caller that stores a copy detaches every predicate from
 * the object that later gets written, and each one silently answers from a
 * snapshot that never fills in. That is #2637, and the failure mode is a
 * `visibleOnly` export shipping a structurally wrong file rather than throwing.
 */

import type { IfcAttributeValue, IfcDataStore, IfcSourceHeader } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcSchemaVersion } from './schema-converter.js';
import type { ExportPass, StepExportOptions } from './step-export-types.js';
import { getEffectiveEntityIndex } from './effective-index.js';
import { createModificationLedger } from './delta-modification-ledger.js';
import { createSourceRefReader } from './source-ref-bounds.js';
import { buildStepHeader } from './step-header.js';

/**
 * Everything the pass literal reads that is not its own field.
 *
 * `dataStore` and `mutationView` are the exporter's, injected rather than
 * reached for. `isGeometryEntity` arrives as a parameter for a different
 * reason: it is the free function in `step-geometry-types.ts`, so taking it
 * here keeps this builder independent of the exporter AND of that module.
 */
export interface PassBuildInput {
  readonly dataStore: IfcDataStore;
  readonly mutationView: MutablePropertyView | null;
  readonly isGeometryEntity: (type: string) => boolean;
  readonly options: StepExportOptions;
  readonly schema: IfcSchemaVersion;
  readonly sourceSchema: IfcSchemaVersion;
  readonly converting: boolean;
  readonly applyMutations: boolean;
  readonly excludeGeometry: boolean;
  readonly sourceHeader: IfcSourceHeader | undefined;
  readonly schemaToken: string;
}

export function buildExportPass(input: PassBuildInput): ExportPass {
  const {
    dataStore,
    mutationView,
    isGeometryEntity,
    options,
    schema,
    sourceSchema,
    converting,
    applyMutations,
    excludeGeometry,
    sourceHeader,
    schemaToken,
  } = input;

  const pass: ExportPass = {
    entities: [],
    newEntityCount: 0,
    schema,
    sourceSchema,
    converting,
    sourceHeader,
    schemaToken,
    overlayActive: !!mutationView && applyMutations,

    // Built once entity counts are known, so the provenance item can report the
    // actual modification count. See the two call sites (empty delta + final).
    // Body lives in `step-header.ts` (#2475 header/assembly tail): the
    // closure still has to be built here, because it closes over this
    // call's own `options`/`sourceHeader`/`schemaToken`, and both call
    // sites still read it as `pass.buildHeader`.
    buildHeader: (modifications: number): string =>
      buildStepHeader(options, sourceHeader, schemaToken, modifications),

    // The one authority for exists / class / deleted, overlay first and source
    // buffer second. Every pass below asks this instead of `dataStore`,
    // which answers only for the file as parsed (#2012).
    effective: getEffectiveEntityIndex(
      dataStore,
      mutationView,
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
    isReadableSourceRef: createSourceRefReader(dataStore.source),

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
      && isGeometryEntity(pass.effective.effectiveType(entityId, recordType)),
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
  // The same object, deliberately. See the file header.
  return pass;
}
