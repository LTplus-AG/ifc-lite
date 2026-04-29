/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addSlabToStore } from './slab.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('addSlabToStore', () => {
  it('emits IfcSlab with a corner-anchored rectangle profile', () => {
    const store = makeStore(40);
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(store, view);

    const result = addSlabToStore(
      editor,
      { ownerHistoryId: 5, bodyContextId: 14, storeyId: 43, storeyPlacementId: 54 },
      { Position: [1, 2, 0], Width: 4, Depth: 3, Thickness: 0.3 },
    );

    const byId = new Map(view.getNewEntities().map((e) => [e.expressId, e]));
    const slab = byId.get(result.slabId);
    expect(slab?.type).toBe('IfcSlab');
    expect(slab?.attributes[8]).toBe('.FLOOR.');

    const profile = byId.get(result.profileId);
    const profilePosRef = profile?.attributes[2] as string;
    const profilePos = byId.get(Number(profilePosRef.replace('#', '')));
    const profileOriginRef = profilePos?.attributes[0] as string;
    const profileOrigin = byId.get(Number(profileOriginRef.replace('#', '')));
    // Profile centre at (Width/2, Depth/2) so the rectangle spans [0..W] × [0..D].
    expect(profileOrigin?.attributes[0]).toEqual([2, 1.5]);
    expect(profile?.attributes[3]).toBe(4);
    expect(profile?.attributes[4]).toBe(3);

    const solid = byId.get(result.solidId);
    expect(solid?.attributes[3]).toBe(0.3); // extrusion = Thickness
  });

  it('rejects non-positive dimensions', () => {
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeStore(10), view);
    expect(() => addSlabToStore(
      editor,
      { ownerHistoryId: 1, bodyContextId: 2, storeyId: 3, storeyPlacementId: 4 },
      { Position: [0, 0, 0], Width: 0, Depth: 1, Thickness: 0.3 },
    )).toThrow(/positive/);
  });
});
