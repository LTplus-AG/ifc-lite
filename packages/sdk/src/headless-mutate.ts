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
 * Checks BOTH halves of a reference, not just the express id, and says which
 * one is wrong: `null` when the backend can write to it, otherwise the reason,
 * phrased as the clause a write method puts after its own name.
 *
 * A reason rather than a boolean because the two failures are different
 * problems and a single message misdescribes one of them: an unknown model id
 * does not mean the entity is missing (it usually exists, in the model the
 * caller meant), and telling them it is missing sends them hunting for the
 * wrong thing. {@link createEffectiveEntityCheck} builds the one both headless
 * backends use.
 */
export type EntityRefCheck = (ref: EntityRef) => string | null;

/**
 * The reference check both headless backends need, written once.
 *
 * `packages/export/src/effective-index.ts` is the authority on the same
 * question for the exporter, and answering it twice is a real hazard: it is not
 * called here because it is not exported from `@ifc-lite/export`, and because
 * it answers about express ids only, with no notion of a model id, which is
 * half of what a reference has to be checked for. If it is ever exported, this
 * is the call site to move onto it.
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
 *   write to the wrong entity. It is reported as its own reason, naming the ids
 *   the backend does answer for, because it is not a missing entity.
 *
 * `overlay` is a thunk and is consulted only once it exists: no overlay means
 * nothing was created or deleted this session, so `hasSourceEntity` is the
 * whole truth and a read-only session still never builds one.
 */
export function createEffectiveEntityCheck(input: {
  acceptedModelIds: readonly string[];
  hasSourceEntity: (expressId: number) => boolean;
  overlay: () => MutablePropertyView | null;
}): EntityRefCheck {
  const known = input.acceptedModelIds.map(id => `'${id}'`).join(' or ');
  return (ref: EntityRef): string | null => {
    if (!input.acceptedModelIds.includes(ref.modelId)) {
      return `unknown model '${ref.modelId}' (this backend answers for ${known})`;
    }
    const missing = `no entity #${ref.expressId} in model '${ref.modelId}' — the write would be silently dropped on export`;
    const view = input.overlay();
    if (view) {
      if (view.getNewEntity(ref.expressId) !== null) return null;
      if (view.isDeleted(ref.expressId)) return missing;
    }
    return input.hasSourceEntity(ref.expressId) ? null : missing;
  };
}

/**
 * Build a `MutateBackendMethods` over a lazily-created mutation view.
 *
 * `checkRef` is what every write method is gated on, so a write to an entity
 * the model does not hold is refused at the call site. It is a required
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
  checkRef: EntityRefCheck,
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
  //
  // The message is the check's, not this function's: a bad model id and a
  // missing entity are different mistakes to recover from, and only the check
  // knows which one it found.
  const requireEntity = (method: string, ref: EntityRef): void => {
    const reason = checkRef(ref);
    if (reason === null) return;
    throw new Error(`${method}: ${reason}`);
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
