/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: tracked replacement stages deletion and canonical creation together. */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SpatialAnchor } from './anchor.js';
import { emitOrdinaryElement, type OrdinaryInStoreElement } from './ordinary-element.js';
import { addStairToStore, type StairInStoreParams } from './stair.js';
import { addRailingToStore, type RailingInStoreParams } from './railing.js';
import { removeStairFromDraft } from './stair-removal.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { liveEntityConforms } from './resolve-relations.js';

/** Existing canonical creation contracts; renderer and history remain host concerns. */
export type InStoreReplacementElement = OrdinaryInStoreElement
  | { kind: 'stair'; params: StairInStoreParams }
  | { kind: 'railing'; params: RailingInStoreParams };

/** Replace a live product, removing both products of a uniquely owned stair.
 * A builder/anchor/ownership refusal preserves the original graph, journal and
 * allocator. Shared shape/style leaves are retained, as with generic removal.
 * Anchor preparation may write into this same draft without nesting a transaction. */
export function replaceElementInStore(
  store: IfcDataStore,
  editor: StoreEditor,
  oldId: number,
  anchor: SpatialAnchor | ((draft: StoreEditor) => SpatialAnchor),
  element: InStoreReplacementElement,
): { expressId: number; flightId?: number; removedIds: number[] } {
  return editor.runAtomic(draft => {
    const view = draft.getMutationView();
    const old = new AnchorEntityReader(store, view).entity(oldId);
    if (!old || !liveEntityConforms(store, oldId, 'IfcProduct', view)) {
      throw new Error(`replaceElementInStore: #${oldId} is not a readable live IfcProduct`);
    }
    const resolved = typeof anchor === 'function' ? anchor(draft) : anchor;
    const removedIds = [oldId];
    if (old.type.toUpperCase() === 'IFCSTAIR') {
      removedIds.push(removeStairFromDraft(store, draft, oldId).flightId);
    } else if (!draft.removeEntity(oldId)) {
      throw new Error(`replaceElementInStore: #${oldId} could not be removed`);
    }
    if (element.kind === 'stair') {
      const built = addStairToStore(draft, resolved, element.params);
      return { expressId: built.stairId, flightId: built.flightId, removedIds };
    }
    const expressId = element.kind === 'railing'
      ? addRailingToStore(draft, resolved, element.params).railingId
      : emitOrdinaryElement(draft, resolved, element);
    return { expressId, removedIds };
  });
}
