/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutationStoreShape } from './types.js';

/**
 * Whether the SOURCE model's index holds `expressId`: the STEP byte index
 * (`entityIndex.byId`) or the property atoms the parser deferred out of it
 * (`deferredEntityIndex`, under `deferPropertyAtomIndex`). Deferred atoms are
 * real entities that the exporter emits and that have ids of their own, so
 * either index counts.
 *
 * This is the one definition of the union. Six sites used to spell it out by
 * hand, and `StoreEditor.removeEntity` was the one that left out the deferred
 * half: `hasEntity` said an atom existed and `removeEntity` returned `false`
 * without deleting it (#5222). The option that turns deferral on is the
 * canonical example in the public parsing guide, so "no internal caller
 * passes it" is not the same as "unreachable".
 *
 * Tombstones and overlay-created entities are not considered here; callers
 * layer those on top.
 */
export function storeHasSourceEntity(store: MutationStoreShape, expressId: number): boolean {
  return store.entityIndex.byId.has(expressId) || store.deferredEntityIndex?.has(expressId) === true;
}
