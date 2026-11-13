/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutationStoreShape } from './types.js';

/**
 * The highest express id a store already owns — the floor for overlay
 * allocation. Three sources, because no single index is complete: the STEP
 * byte index, the property atoms the parser deferred out of it on huge files
 * (they sit above `max(byId)` and the exporter emits them), and the entity
 * table, which is the only membership record for stores without a byte
 * index (IFCX imports, reconstructed collab rooms — #5008).
 */
interface WatermarkKey {
  byId: unknown; byIdSize: number;
  deferred: unknown; deferredSize: number;
  table: unknown; tableLength: number;
  max: number;
}
const watermarks = new WeakMap<object, WatermarkKey>();

function watermarkKey(store: MutationStoreShape, max: number): WatermarkKey {
  // @raw-entity-enumeration-ok index identities and sizes only; no ids are read
  const byId = store.entityIndex.byId, deferred = store.deferredEntityIndex, table = store.entities?.expressId;
  return { byId, byIdSize: byId.size, deferred, deferredSize: deferred?.size ?? 0, table, tableLength: table?.length ?? 0, max };
}

/**
 * The same answer, computed once per store rather than once per editor
 * (#8452): every transaction and preview builds an editor, and on a large
 * model each scan visited every source id. Source indexes only grow
 * (hydration and federation add ids; tombstones never remove one), so an
 * index with the same identity and size has the same maximum. Any change of
 * identity or size rescans. A store that grew without either changing is
 * still caught: `StoreEditor.addEntity` checks the next id against the source
 * before allocating and then forces {@link rescanHighestExpressId}.
 */
export function highestExistingExpressId(store: MutationStoreShape): number {
  const cached = watermarks.get(store);
  if (cached) {
    const key = watermarkKey(store, cached.max);
    if (key.byId === cached.byId && key.byIdSize === cached.byIdSize && key.deferred === cached.deferred
      && key.deferredSize === cached.deferredSize && key.table === cached.table && key.tableLength === cached.tableLength) return cached.max;
  }
  return rescanHighestExpressId(store);
}

/** Scan every source index and replace the per-store cached maximum. */
export function rescanHighestExpressId(store: MutationStoreShape): number {
  const max = scanHighestExpressId(store);
  watermarks.set(store, watermarkKey(store, max));
  return max;
}

function scanHighestExpressId(store: MutationStoreShape): number {
  let max = 0;
  // @raw-entity-enumeration-ok allocator watermark must include tombstoned source IDs so a new entity never reuses one
  for (const id of store.entityIndex.byId.keys()) {
    if (id > max) max = id;
  }
  const deferred = store.deferredEntityIndex;
  if (deferred) {
    for (const id of deferred.keys()) {
      if (id > max) max = id;
    }
  }
  const table = store.entities?.expressId;
  if (table) {
    for (let i = 0; i < table.length; i++) {
      const id = table[i];
      if (id !== undefined && id > max) max = id;
    }
  }
  return max;
}
