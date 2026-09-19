/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pending-mutation overlay the cost read model reads THROUGH (#4857).
 *
 * `extractCostOnDemand` reads a loaded model's cost graph straight out of the
 * source bytes. A loaded model, though, also carries an edit overlay — the
 * viewer's `MutablePropertyView` — that the STEP exporter applies on the way
 * out. Without this module the two disagree: rename an `IfcCostItem` in a
 * loaded model and `bim.cost.data()` still reports the on-disk name while
 * `bim.export.ifc()` writes the new one.
 *
 * WHERE THIS IS APPLIED, AND WHY THERE
 *
 * At `CostEntityReader` — the single funnel every cost extractor reads an
 * entity through (`ids`, `get`, `typeOf`, `attributeLexeme`) — and nowhere
 * else. Projecting the overlay onto the finished `CostGraphExtraction`
 * instead would mean re-deriving nesting parents, child lists, controlling
 * schedules, compatibility value trees, unit resolution and every diagnostic
 * a second time, from a second implementation. Applied at the reader, the
 * whole of that derivation recomputes itself from one path, and an overlaid
 * model reads EXACTLY as a file that literally stated those values would.
 *
 * The consequence is deliberate and is the safe-delete answer: a cost value
 * deleted while an `IfcCostItem` still lists it in `CostValues` reads back as
 * a `MISSING_REFERENCE` **error** diagnostic against that item — the same
 * answer the reader already gives for a file with a genuinely dangling
 * reference.
 *
 * WHY THE OVERLAY HANDS OVER RECORD TEXT, NOT EDITS
 *
 * What an edit becomes in the file is the exporter's decision: an enum slot
 * is written `.ADD.`, a string slot `'ADD'`, a REAL slot refuses a non-number,
 * a positional value is SELECT-qualified, a retype re-lays-out the argument
 * list, and a slot past the end of a truncated record is skipped. A parser-
 * side copy of those rules is a second implementation that drifts — the first
 * version of this overlay quoted every value, so an `ArithmeticOperator` edit
 * read as absent while export wrote `.ADD.`. So the overlay returns the record
 * as `@ifc-lite/export`'s `effectiveSourceRecord` writes it, and the reader
 * parses that text exactly as it parses the file.
 */

/**
 * A loaded model's pending edits, as the cost read model observes them. The
 * SDK builds one from a `MutablePropertyView` over `@ifc-lite/export`'s
 * `effectiveSourceRecord`; every member is required, so an overlay cannot
 * quietly omit an edit kind.
 */
export interface CostMutationOverlay {
  /** True when `expressId` is tombstoned — deleted, pending export. */
  isDeleted(expressId: number): boolean;
  /** Pending class of every retyped entity, keyed by expressId (any casing). */
  retypes(): ReadonlyMap<number, string>;
  /**
   * The record `expressId` as the exporter will write it, given its source
   * text and class. `notWritten` lists pending edits the exporter declines to
   * place (it keeps the source slot and warns); the reader reports each as a
   * diagnostic instead of passing the source value off as current.
   */
  effectiveRecord(expressId: number, sourceText: string, sourceType: string): {
    text: string;
    notWritten: readonly string[];
  };
  /**
   * Every entity the overlay CREATED (`bim.store.addEntity` /
   * `StoreEditor.addEntity`) — PR A of #4857, "loaded-model cost authoring".
   * Each entry carries its effective class and its record TEXT exactly as
   * `@ifc-lite/export`'s `effectiveCreatedRecord` (the exporter's own
   * overlay-created-entity writer, `writeOverlayCreatedEntities`) would emit
   * it, so a freshly authored `IfcCostItem` reads through `bim.cost` exactly
   * as the file that will be exported would state it — before the model is
   * ever exported.
   *
   * A created entity the overlay later tombstoned is never in this list:
   * `StoreEditor.removeEntity` forgets an overlay-only entity outright, so it
   * simply falls out of the underlying entity list. `error` is set instead of
   * `type`/`text` when the entity's authored argument list does not scan for
   * a pending retype — the same condition export declines to write under —
   * and the reader reports it as a diagnostic rather than treating the entity
   * as absent from the source it never had.
   */
  created(): readonly CostCreatedRecord[];
}

/** One overlay-created entity as `CostMutationOverlay.created()` reports it. */
export interface CostCreatedRecord {
  expressId: number;
  /** The effective (post-retype) IFC class, UPPERCASE. Present iff `error` is not. */
  type?: string;
  /** The record text exactly as export would write it. Present iff `error` is not. */
  text?: string;
  /** Present instead of `type`/`text` when the record could not be read (see above). */
  error?: string;
}

/** Options for `extractCostOnDemand`. */
export interface CostExtractionOptions {
  /**
   * The loaded model's pending edits (#4857). When supplied, every entity the
   * extraction reads is read THROUGH the overlay, so the graph returned
   * describes the model as the exporter would write it — not as the file on
   * disk states it. Omit it for the on-disk graph.
   */
  overlay?: CostMutationOverlay;
}
