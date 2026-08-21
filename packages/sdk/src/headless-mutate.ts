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
 * Build a `MutateBackendMethods` over a lazily-created mutation view.
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
): MutateBackendMethods {
  return {
    setProperty(ref: EntityRef, psetName: string, propName: string, value: string | number | boolean): void {
      getView().setProperty(ref.expressId, psetName, propName, value, propertyValueTypeOf(value));
    },
    setAttribute(ref: EntityRef, attrName: string, value: string): void {
      getView().setAttribute(ref.expressId, attrName, value);
    },
    deleteProperty(ref: EntityRef, psetName: string, propName: string): void {
      getView().deleteProperty(ref.expressId, psetName, propName);
    },
    batchBegin(): void { /* no history to group */ },
    batchEnd(): void { /* no history to group */ },
    undo(): boolean { return false; },
    redo(): boolean { return false; },
  };
}
