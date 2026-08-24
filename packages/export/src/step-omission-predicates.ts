/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which ids a STEP export may still NAME, once it has decided which ids it is
 * writing.
 *
 * Split out of `step-exporter.ts` for #2475, verbatim apart from the two
 * changes noted below. It runs immediately after `collectModifications` and
 * before the output passes, and that position is not incidental: everything
 * here reads what the collection phase produced -- `pass.modifiedEntities`,
 * `pass.newGeorefLines`, `pass.allowedEntityIds`, `pass.overlayActive` -- and
 * everything the output passes do with omitted references reads what this
 * returns. Calling it earlier gives answers computed from an unpopulated pass.
 *
 * Why not in `step-collection.ts`: that module produces the values these
 * predicates consume and never reads them back, so putting them there would
 * relocate a dependency rather than remove one. That argument was always about
 * `step-collection.ts` specifically, not about these predicates being welded
 * to `export()`.
 *
 * TWO CHANGES FROM THE ORIGINAL, both forced by it becoming a function:
 *
 * 1. The deltaOnly empty short-circuit used to `return` out of `export()`.
 *    A free function cannot, so it returns a tagged `'short-circuit'` result
 *    the caller returns instead. That rewrite is safe by measurement, not by
 *    argument: disabling the branch entirely leaves the suite green and the
 *    emitted bytes and stats identical, because for a model with no edits the
 *    ordinary path arrives at the same place. See
 *    `delta-empty-shortcircuit.test.ts`, which pins the contract and says
 *    outright that it does not pin the branch.
 * 2. `this.mutationView` arrives as a parameter.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ExportPass, StepExportOptions, StepExportResult } from './step-export-types.js';

/**
 * Either the export is already over, or here are the two things the output
 * passes need from it.
 *
 * A tagged union rather than an optional field, so a caller cannot read
 * `isOmittedFromOutput` off a short-circuited result and get `undefined`
 * without the compiler saying so.
 */
export type OmissionEvaluation =
  | { readonly kind: 'short-circuit'; readonly result: StepExportResult }
  | {
      readonly kind: 'continue';
      readonly isOmittedFromOutput: (id: number) => boolean;
      /** A boolean, not a predicate: the precondition both filter sites gate on. */
      readonly mayNameOmittedRefs: boolean;
    };

export function evaluateOmissionPredicates(
  pass: ExportPass,
  options: StepExportOptions,
  applyMutations: boolean,
  excludeGeometry: boolean,
  mutationView: MutablePropertyView | null,
): OmissionEvaluation {
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
    mutationView
    && applyMutations
    && typeof mutationView.getNewEntities === 'function'
  ) ? mutationView.getNewEntities().length : 0;
  // Georef-only deltas (newGeorefLines populated but no entity changes) must
  // still produce a non-empty DATA section.
  if (
    // `=== true`, matching `step-pass-builder.ts`'s two reads of the same
    // option. A plain-JS caller passing `deltaOnly: 1` would otherwise have
    // this module call the export a delta while the predicates there call it
    // a full export -- the same divergence this file argues against for
    // `visibleOnly` a few paragraphs down.
    options.deltaOnly === true
    && pass.modifiedEntities.size === 0
    && overlayNewEntityCount === 0
    && pass.newGeorefLines.length === 0
  ) {
    const emptyContent = new TextEncoder().encode(pass.buildHeader(0) + 'DATA;\nENDSEC;\nEND-ISO-10303-21;\n');
    return {
      kind: 'short-circuit',
      result: {
        content: emptyContent,
        stats: {
          entityCount: 0,
          newEntityCount: 0,
          modifiedEntityCount: 0,
          fileSize: emptyContent.byteLength,
          warnings: pass.warnings,
        },
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
   * ctx.dataStore.source)` in `step-collection.ts` — quoted rather than cited
   * by line, because the line moved by three in the very commit that added
   * this reference — which is TRUTHY rather than `=== true`, and which
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
  return { kind: 'continue', isOmittedFromOutput, mayNameOmittedRefs };
}
