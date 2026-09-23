/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A remote peer's write never touches the local undo/redo stacks
 * (`collabSlice.ts`'s inbound handlers apply it directly to the model), but a
 * queued local `redo()` still replays a value captured before that write —
 * silently overwriting the peer's edit (#5223). This module is the shared fix
 * for both directions:
 *
 *   - `filterRedoForEntity`: drop that entity's entries from the redo stack
 *     the moment a remote write lands on it (called from collabSlice.ts).
 *   - `isTargetTombstoned`: refuse to replay ANY queued undo/redo entry (not
 *     just redo) onto an entity a remote peer has since deleted — the
 *     fallback for an entry queued in the same tick as the delete, before
 *     `filterRedoForEntity` could drop it.
 */

import type { Mutation } from '@ifc-lite/mutations';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** A zustand `set()` patch dropping `entityId`'s entries from `modelId`'s redo
 * stack, or `{}` (no-op) if nothing changed. */
export function invalidateRedoPatch(
  redoStacks: Map<string, Mutation[]>, modelId: string, entityId: number,
): { redoStacks?: Map<string, Mutation[]> } {
  const current = redoStacks.get(modelId);
  if (!current || current.length === 0) return {};
  const filtered = current.filter((m) => m.entityId !== entityId);
  return filtered.length === current.length ? {} : { redoStacks: new Map(redoStacks).set(modelId, filtered) };
}

/** CREATE_ENTITY/DELETE_ENTITY are exempt: they ARE the entity's own
 * lifecycle transition and must run regardless of tombstone state. */
export function isTargetTombstoned(view: MutablePropertyView, mutation: Mutation): boolean {
  return mutation.type !== 'CREATE_ENTITY'
    && mutation.type !== 'DELETE_ENTITY'
    && view.isDeleted(mutation.entityId);
}
