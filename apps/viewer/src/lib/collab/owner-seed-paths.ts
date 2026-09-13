/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import { pathForEntity, registerEntityMaps, registerStoreSlot } from './entity-paths';

/** Bind the live pre-share store to paths allocated from its materialized seed. */
export function registerLiveSeedStore(
  liveStore: IfcDataStore | undefined,
  seedStore: IfcDataStore,
  slot: ModelSlotRef,
): void {
  registerStoreSlot(seedStore, slot);
  if (!liveStore || liveStore === seedStore) return;
  registerStoreSlot(liveStore, slot);
  const idToPath = new Map<number, string>();
  const pathToId = new Map<string, number>();
  for (const [expressId] of seedStore.entityIndex.byId) {
    const path = pathForEntity(seedStore, expressId);
    if (!path) continue;
    idToPath.set(expressId, path);
    pathToId.set(path, expressId);
  }
  registerEntityMaps(liveStore, idToPath, pathToId);
}
