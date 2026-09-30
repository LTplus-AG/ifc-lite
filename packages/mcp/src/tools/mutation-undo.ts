/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Revert compound hosted commits and raw mutation operations (#6232 D5). */
import type { MutablePropertyView, Mutation } from '@ifc-lite/mutations';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { undoMutationCount } from '../headless-backend-modelling.js';

type MutationView = MutablePropertyView;

/**
 * Apply the inverse of one mutation-history entry to the live overlay.
 *
 * `MutablePropertyView.mutationHistory` is deliberately append-only (see the
 * package's own docs on `getMutations()` / `hasChanges()`) — popping it, on
 * its own, reverts nothing. This mirrors the inverse-mutation dispatch the
 * viewer's undo stack applies (`apps/viewer/src/store/slices/mutationSlice.ts`),
 * scoped to the mutation types this package's own tools can produce.
 * `skipHistory: true` throughout so reverting a mutation does not itself
 * grow the history mutation_undo just trimmed it from.
 */
function revertMutation(view: MutationView, mutation: Mutation): void {
  switch (mutation.type) {
    case 'CREATE_PROPERTY':
      if (mutation.psetName && mutation.propName) {
        view.deleteProperty(mutation.entityId, mutation.psetName, mutation.propName, true);
      }
      return;
    case 'UPDATE_PROPERTY':
    case 'DELETE_PROPERTY':
      if (mutation.psetName && mutation.propName && mutation.oldValue !== undefined) {
        view.setProperty(
          mutation.entityId,
          mutation.psetName,
          mutation.propName,
          mutation.oldValue,
          mutation.valueType,
          undefined,
          true,
        );
      }
      return;
    case 'UPDATE_ATTRIBUTE':
      if (mutation.attributeName) {
        if (mutation.oldValue !== undefined && mutation.oldValue !== null) {
          view.setAttribute(mutation.entityId, mutation.attributeName, String(mutation.oldValue), undefined, true);
        } else {
          view.removeAttributeMutation(mutation.entityId, mutation.attributeName);
        }
      }
      return;
    case 'CREATE_ENTITY':
      view.deleteEntity(mutation.entityId);
      return;
    case 'DELETE_ENTITY':
      view.restoreFromTombstone(mutation.entityId);
      return;
    default:
      // Types this package's tools never emit (quantities, positional attrs,
      // retype) — surfaced rather than silently dropped, so a future tool
      // that starts emitting one of these does not get a no-op undo.
      throw new ToolExecutionError({
        code: ToolErrorCode.INVALID_INPUT,
        message: `mutation_undo: '${mutation.type}' mutations are not revertible by this tool.`,
      });
  }
}

export function undoPendingMutations(view: MutationView, n: number): number {
  const history = view.getMutations();
  const undone = undoMutationCount(view, n);
  const toUndo = history.slice(history.length - undone);
  view.runAtomic(draft => {
    for (let i = toUndo.length - 1; i >= 0; i--) revertMutation(draft, toUndo[i]);
    // Deleting a created entity replaces the journal and writes an inverse
    // DELETE_ENTITY entry. Restore the stable prefix after every inverse,
    // rather than trimming a detached pre-delete array.
    (draft as unknown as { mutationHistory: Mutation[] }).mutationHistory = history.slice(0, history.length - undone);
  });
  return undone;
}
