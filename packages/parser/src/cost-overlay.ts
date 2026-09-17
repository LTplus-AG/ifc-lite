/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pending-mutation overlay the cost read model reads THROUGH (#4857).
 *
 * `extractCostOnDemand` reads a loaded model's cost graph straight out of the
 * source bytes. A loaded model, though, also carries an edit overlay — the
 * viewer's `MutablePropertyView` — that the STEP exporter applies on the way
 * out (`applyMutations`). Without this module the two disagree: rename an
 * `IfcCostItem` in a loaded model and `bim.cost.data()` still reports the
 * on-disk name while `bim.export.ifc()` writes the new one.
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
 * reference. The dangling id is not quietly dropped from the canonical
 * `CostValues` list, because quietly dropping it would report a coherent
 * graph that the file does not contain.
 *
 * SHAPE
 *
 * {@link CostMutationOverlay} is structurally the subset of
 * `MutablePropertyView` this needs, so the viewer hands its view straight in
 * and `@ifc-lite/parser` gains no dependency on `@ifc-lite/mutations`. Both
 * members are optional: an overlay that only tombstones and an overlay that
 * only renames are both valid.
 */

import { attrIndex, stepSourceSchema, type SourceStepSchema } from './step-attribute-index.js';

/**
 * A loaded model's pending edits, as much of them as the cost read model can
 * observe. Structurally satisfied by `MutablePropertyView`.
 */
export interface CostMutationOverlay {
  /** True when `expressId` is tombstoned — deleted, pending export. */
  isDeleted?(expressId: number): boolean;
  /**
   * Pending named-attribute edits for `expressId`. Names are EXPRESS
   * attribute names (`Name`, `Identification`, …), resolved to a positional
   * slot by the same `attrIndex` the STEP exporter resolves them with.
   */
  getAttributeMutationsForEntity?(expressId: number): ReadonlyArray<{ name: string; value: string }>;
}

/**
 * Escape a pending edit's value into a STEP string literal.
 *
 * `MutablePropertyView.setAttribute` values are always strings, so the slot
 * being written is always a string-valued one (`IfcLabel`, `IfcIdentifier`,
 * `IfcText`, `IfcDateTime`, `IfcGloballyUniqueId`). An empty string stays an
 * empty string literal — `''`, a PRESENT empty label — and never becomes `$`:
 * #4881 made absent and empty distinct end to end in the cost read model, and
 * collapsing them here would undo that for exactly the entities an edit
 * touched.
 */
export function costOverlayStringLexeme(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Resolve a pending edit's slot overrides for one entity: slot index ->
 * replacement value, with the raw string kept alongside the STEP lexeme so
 * the reader can patch both its parsed-attribute view and its lexeme view
 * from one lookup.
 *
 * An attribute name the type does not declare resolves to `-1` and is
 * dropped, matching `applyAttributeMutations` in `@ifc-lite/export`: an edit
 * that names no slot lands nowhere on export either, so reporting it in the
 * read model would invent an agreement that does not exist.
 */
export function costOverlaySlotOverrides(
  overlay: CostMutationOverlay,
  expressId: number,
  type: string,
  schemaVersion: string | undefined,
): Map<number, { raw: string; lexeme: string }> | undefined {
  const mutations = overlay.getAttributeMutationsForEntity?.(expressId);
  if (!mutations || mutations.length === 0) return undefined;
  const schema: SourceStepSchema | undefined = stepSourceSchema(schemaVersion);
  const slots = new Map<number, { raw: string; lexeme: string }>();
  for (const mutation of mutations) {
    const index = attrIndex(type, mutation.name, schema);
    if (index < 0) continue;
    slots.set(index, { raw: mutation.value, lexeme: costOverlayStringLexeme(mutation.value) });
  }
  return slots.size > 0 ? slots : undefined;
}
