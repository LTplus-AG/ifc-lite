/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: tracked replacement stages deletion and canonical creation together. */
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SpatialAnchor, SpatialAnchorSchema } from './anchor.js';
import { emitOrdinaryElement, type OrdinaryInStoreElement } from './ordinary-element.js';
import { addStairToStore, type StairInStoreParams } from './stair.js';
import { addRailingToStore, type RailingInStoreParams } from './railing.js';
import { removeStairFromDraft } from './stair-removal.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import { asRef } from './style-entity-reader.js';

/** Only classes whose removal contract this replacement operation owns. */
const SOURCE_CLASSES = ['IfcWall', 'IfcColumn', 'IfcSlab', 'IfcBeam', 'IfcSpace',
  'IfcRoof', 'IfcPlate', 'IfcMember', 'IfcStair', 'IfcRailing'] as const;

/** Existing canonical creation contracts; renderer and history remain host concerns. */
export type InStoreReplacementElement = OrdinaryInStoreElement
  | { kind: 'stair'; params: StairInStoreParams }
  | { kind: 'railing'; params: RailingInStoreParams };

/** Replace a supported ordinary product or uniquely owned single-flight stair.
 * Other product classes and non-stair aggregate roots refuse before preparation.
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
    const reader = new AnchorEntityReader(store, view), old = reader.entity(oldId);
    const registry = schemaRegistry((store.schemaVersion ?? 'IFC4') as SpatialAnchorSchema, 'replaceElementInStore');
    if (!old || !conformsTo(registry, old.type, 'IfcProduct')) {
      throw new Error(`replaceElementInStore: #${oldId} is not a readable live IfcProduct`);
    }
    if (!SOURCE_CLASSES.some(type => conformsTo(registry, old.type, type))) {
      throw new Error(`replaceElementInStore: unsupported replacement source #${oldId} (${old.type})`);
    }
    if (old.type.toUpperCase() !== 'IFCSTAIR') {
      for (const relationshipId of reader.ids('IFCRELAGGREGATES')) {
        const relationship = reader.entity(relationshipId);
        if (!relationship) throw new Error(`replaceElementInStore: assembly relationship #${relationshipId} cannot be read`);
        if (asRef(relationship.attributes[4]) === oldId) {
          throw new Error(`replaceElementInStore: unsupported assembly source #${oldId} (${old.type})`);
        }
      }
    }
    // Rebuilding the root alone cannot transfer its openings/fillings. Refuse
    // rather than deleting the host and leaving independently live children.
    for (const relationshipId of reader.ids('IFCRELVOIDSELEMENT')) {
      const relationship = reader.entity(relationshipId);
      if (!relationship) throw new Error(`replaceElementInStore: void relationship #${relationshipId} cannot be read`);
      if (asRef(relationship.attributes[4]) === oldId) {
        throw new Error(`replaceElementInStore: unsupported hosted-opening source #${oldId} (${old.type}); edit the host in place`);
      }
    }
    const removedIds = [oldId];
    if (old.type.toUpperCase() === 'IFCSTAIR') {
      removedIds.push(removeStairFromDraft(store, draft, oldId).flightId);
    } else if (!draft.removeEntity(oldId)) {
      throw new Error(`replaceElementInStore: #${oldId} could not be removed`);
    }
    const resolved = typeof anchor === 'function' ? anchor(draft) : anchor;
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
