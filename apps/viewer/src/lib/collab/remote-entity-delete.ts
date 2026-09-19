/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { unregisterEntityPath } from './entity-paths';

/** Apply a remote tombstone atomically with path removal. */
export function deleteRemoteOverlayEntity(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  entityId: number,
): boolean {
  if (!view) return false;
  view.deleteEntity(entityId);
  unregisterEntityPath(store, entityId);
  return true;
}

/**
 * Recipient reconstructions allocate dense express ids afresh. Keep the
 * short-lived tombstone used to hide a peer deletion tied to its stable room
 * path, then remove that numeric tombstone only once a replacement snapshot
 * proves the path is gone. Otherwise a surviving entity that inherits the old
 * number would remain hidden after reconstruction.
 */
export class RemoteDeleteTombstones {
  private readonly pending = new Map<string, Map<string, number>>();

  record(modelId: string, entityPath: string, entityId: number): void {
    let model = this.pending.get(modelId);
    if (!model) {
      model = new Map();
      this.pending.set(modelId, model);
    }
    model.set(entityPath, entityId);
  }

  reconcile(
    modelId: string,
    pathToId: ReadonlyMap<string, number> | undefined,
    view: MutablePropertyView | undefined,
  ): number {
    const model = this.pending.get(modelId);
    if (!model || !pathToId || !view) return 0;
    let restored = 0;
    for (const [path, oldId] of model) {
      // A snapshot taken before the delete may still contain the path. Retain
      // its tombstone until the next debounced reconstruction catches up.
      if (pathToId.has(path)) continue;
      if (view.restoreFromTombstone(oldId)) restored += 1;
      model.delete(path);
    }
    if (model.size === 0) this.pending.delete(modelId);
    return restored;
  }

  clear(): void {
    this.pending.clear();
  }
}
