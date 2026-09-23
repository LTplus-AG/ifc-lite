/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one tombstone guard every inbound collab write passes through (#5187).
 *
 * A peer's write to an entity the local user has deleted must be REFUSED, not
 * recorded: `MutablePropertyView` records property and attribute writes
 * regardless of tombstone state, and `restoreFromTombstone` (undoing the local
 * delete) clears only the tombstone, so a write accepted while deleted comes
 * back live on the restored entity, in a slot the local user never edited.
 *
 * Before #5187 the check lived inside ONE handler's helper
 * (`applyRemoteAttribute`), and the property, property-delete and pset-delete
 * handlers had none. Guarding at the dispatch point instead — `attachRemoteApply`
 * wraps its handlers with `guardTombstonedWrites` before dispatching anything —
 * means a handler cannot be added or rewritten without the guard: there is no
 * per-handler copy to forget.
 *
 * The guard stays at this collab boundary, not inside `MutablePropertyView`'s
 * write methods, because undo/redo replay calls those unconditionally by
 * design and must not be refused.
 *
 * Deliberately NOT guarded:
 * - `onPlacement` writes no `MutablePropertyView` record (it reconciles
 *   renderer mesh-delta bookkeeping only), so there is nothing for
 *   `restoreFromTombstone` to resurrect.
 * - `onEntityDelete` / `onEntityCreate` are lifecycle events with their own
 *   tombstone handling (`remote-entity-create.ts`, `remote-entity-delete.ts`).
 */

import type { RemoteApplyHandlers } from './mutation-bridge';

/** What a handler set must supply so the guard can consult local tombstones. */
export interface TombstoneGuardHandlers {
  /** Whether `entityId` is a local tombstone in model `modelId`'s mutation view. */
  isLocallyDeleted(modelId: string, entityId: number): boolean;
  /** A remote write was refused; `reason` names the entity. Never silent. */
  onRejectedWrite(reason: string): void;
}

/**
 * Wrap `handlers` so every view-writing callback first refuses a write to a
 * locally tombstoned entity, reporting it through `onRejectedWrite`.
 */
export function guardTombstonedWrites(handlers: RemoteApplyHandlers): RemoteApplyHandlers {
  const refused = (modelId: string, entityId: number): boolean => {
    if (!handlers.isLocallyDeleted(modelId, entityId)) return false;
    handlers.onRejectedWrite(`entity ${entityId} is locally deleted`);
    return true;
  };
  const { onPsetDelete } = handlers;
  return {
    isLocallyDeleted: (modelId, entityId) => handlers.isLocallyDeleted(modelId, entityId),
    onRejectedWrite: (reason) => handlers.onRejectedWrite(reason),
    onProperty: (modelId, entityId, ...rest) => {
      if (!refused(modelId, entityId)) handlers.onProperty(modelId, entityId, ...rest);
    },
    onPropertyDelete: (modelId, entityId, ...rest) => {
      if (!refused(modelId, entityId)) handlers.onPropertyDelete(modelId, entityId, ...rest);
    },
    onAttribute: (modelId, entityId, ...rest) => {
      if (!refused(modelId, entityId)) handlers.onAttribute(modelId, entityId, ...rest);
    },
    onPsetDelete: onPsetDelete && ((modelId, entityId, pset) => {
      if (!refused(modelId, entityId)) onPsetDelete.call(handlers, modelId, entityId, pset);
    }),
    onPlacement: handlers.onPlacement?.bind(handlers),
    onEntityDelete: handlers.onEntityDelete?.bind(handlers),
    onEntityCreate: handlers.onEntityCreate?.bind(handlers),
  };
}
