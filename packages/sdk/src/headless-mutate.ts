/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.mutate.*` implementation for backends that hold an `IfcDataStore`
 * directly — the CLI's `ifc-lite run` context and the MCP session.
 *
 * Both used to answer every method with a no-op, which is worse than throwing:
 * a script's edits were reported as made and the export came back identical to
 * its input, with nothing saying they had been dropped. The write path that
 * persists was already there — `MutablePropertyView`, which `StepExporter`
 * reads when `applyMutations` is on — nothing was routed into it.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EntityRef, MutateBackendMethods } from './types.js';

/**
 * The `PropertyValueType` for a JavaScript value.
 *
 * `MutablePropertyView.setProperty` defaults to `String`, so passing a boolean
 * through unclassified writes `IFCLABEL('true')` where the caller meant
 * `IFCBOOLEAN(.T.)`.
 *
 * Takes `unknown` so every caller that has to classify a value can share it —
 * anything that is not a boolean or a number is written as a label.
 */
export function propertyValueTypeOf(value: unknown): PropertyValueType {
  if (typeof value === 'boolean') return PropertyValueType.Boolean;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? PropertyValueType.Integer : PropertyValueType.Real;
  }
  return PropertyValueType.String;
}

/**
 * Answers whether a reference names an entity a backend can actually write to —
 * BOTH halves of the reference, not just the express id.
 * {@link createEffectiveEntityExists} builds the one both headless backends use.
 */
export type EntityExistsPredicate = (ref: EntityRef) => boolean;

/**
 * The `entityExists` predicate both headless backends need, written once.
 *
 * Neither question it answers has an obvious source to read, which is why this
 * is shared rather than re-derived per backend:
 *
 * - The express id is resolved against the EFFECTIVE model, not
 *   `store.entityIndex.byId`. `StoreEditor.addEntity` deliberately keeps
 *   created ids out of that index (it may be a `CompactEntityIndex` over
 *   immutable typed arrays), so an id `bim.store.addEntity` just handed back is
 *   real while the base index has never heard of it; a tombstoned entity is in
 *   the base index while being exported nowhere. Both would be answered wrong.
 * - The model id is checked because the write methods do not pass it on — they
 *   forward `ref.expressId` into the one overlay the backend holds. A reference
 *   carrying another model's id, left unchecked, is not a dropped write but a
 *   write to the wrong entity.
 *
 * `overlay` is a thunk and is consulted only once it exists: no overlay means
 * nothing was created or deleted this session, so `hasSourceEntity` is the
 * whole truth and a read-only session still never builds one.
 */
export function createEffectiveEntityExists(input: {
  acceptsModelId: (modelId: string) => boolean;
  hasSourceEntity: (expressId: number) => boolean;
  overlay: () => MutablePropertyView | null;
}): EntityExistsPredicate {
  return (ref: EntityRef): boolean => {
    if (!input.acceptsModelId(ref.modelId)) return false;
    const view = input.overlay();
    if (view) {
      if (view.getNewEntity(ref.expressId) !== null) return true;
      if (view.isDeleted(ref.expressId)) return false;
    }
    return input.hasSourceEntity(ref.expressId);
  };
}

/**
 * Build a `MutateBackendMethods` over a lazily-created mutation view.
 *
 * `entityExists` is what every write method is gated on, so a write to an
 * entity the model does not hold is refused at the call site. It is a required
 * parameter rather than an optional one: a backend that forgot to pass it would
 * otherwise go back to accepting phantom writes with nothing to say it had.
 *
 * `getView` is a thunk rather than a view because both backends create the
 * overlay on first write: it carries the on-demand property and quantity
 * extractors that give the overlay a base to merge against, and building it
 * for a session that never edits anything is wasted work.
 *
 * `undo` / `redo` answer `false`. The mutation history they would walk belongs
 * to the viewer's store, and neither headless backend has one; a `false` return
 * is the documented "nothing to undo" answer, so callers read it correctly.
 * `batchBegin` / `batchEnd` are accepted and ignored for the same reason — they
 * group undo steps, and there are none. This matches the viewer adapter, whose
 * own batch methods are still a documented TODO.
 */
export function createHeadlessMutateAdapter(
  getView: () => MutablePropertyView,
  entityExists: EntityExistsPredicate,
): MutateBackendMethods {
  // A write to an entity the model does not hold used to be accepted in
  // silence: `MutablePropertyView` created the overlay entry for it, the query
  // overlay echoed it back as if the edit had landed, and the exporter — which
  // only ever visits entities the effective model holds — dropped it with no
  // diagnostic. Nowhere in that round trip could the caller see the mistake, so
  // the write site is where it has to be reported (#3764).
  //
  // Every write method is gated, not just `setProperty`: `setAttribute` and
  // `deleteProperty` reach the same overlay through the same unvalidated
  // `ref.expressId` and are dropped by the same exporter walk, so guarding one
  // of the three would leave the defect class intact behind a fixed instance.
  const requireEntity = (method: string, ref: EntityRef): void => {
    if (entityExists(ref)) return;
    throw new Error(
      `${method}: no entity #${ref.expressId} in model '${ref.modelId}' — the write would be silently dropped on export`,
    );
  };
  return {
    setProperty(ref: EntityRef, psetName: string, propName: string, value: string | number | boolean): void {
      requireEntity('setProperty', ref);
      getView().setProperty(ref.expressId, psetName, propName, value, propertyValueTypeOf(value));
    },
    setAttribute(ref: EntityRef, attrName: string, value: string): void {
      requireEntity('setAttribute', ref);
      getView().setAttribute(ref.expressId, attrName, value);
    },
    deleteProperty(ref: EntityRef, psetName: string, propName: string): void {
      requireEntity('deleteProperty', ref);
      getView().deleteProperty(ref.expressId, psetName, propName);
    },
    batchBegin(): void { /* no history to group */ },
    batchEnd(): void { /* no history to group */ },
    undo(): boolean { return false; },
    redo(): boolean { return false; },
  };
}
