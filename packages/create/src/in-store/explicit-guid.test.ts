/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GlobalId` on the in-store params: a caller that derives element
 * identity from a stable key (a flow graph's tracking key) gets exactly
 * that GUID on the product, relationships keep their own generated ones,
 * and a malformed GUID is refused rather than replaced.
 */

import { describe, expect, it } from 'vitest';
import { generateIfcGuid, isValidIfcGuid } from '@ifc-lite/encoding';
import { MutablePropertyView, StoreEditor, type MutationEntityRef, type MutationStoreShape } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { addDoorToStore } from './door.js';
import { addMemberToStore } from './member.js';
import { addPlateToStore } from './plate.js';
import { addRoofToStore } from './roof.js';
import { addSlabToStore } from './slab.js';
import { addSpaceToStore } from './space.js';
import { addWallToStore } from './wall.js';
import { addWindowToStore } from './window.js';

function makeStore(maxId: number): MutationStoreShape {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

const anchor: SpatialAnchor = { ownerHistoryId: 5, bodyContextId: 14, axisContextId: 15, storeyId: 43, storeyPlacementId: 54 };

function fresh() {
  const view = new MutablePropertyView(null, 'm1');
  const editor = new StoreEditor(makeStore(100), view);
  const guidOf = (expressId: number) => view.getNewEntity(expressId)?.attributes[0];
  return { editor, view, guidOf };
}

describe('explicit GlobalId on in-store builders', () => {
  it('every product builder stamps the supplied GlobalId on the product only', () => {
    const { editor, view, guidOf } = fresh();
    const guids = Array.from({ length: 10 }, () => generateIfcGuid());
    const ids = [
      addWallToStore(editor, anchor, { GlobalId: guids[0], Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }).wallId,
      addSlabToStore(editor, anchor, { GlobalId: guids[1], Profile: 'rectangle', Position: [0, 0, 0], Width: 5, Depth: 4, Thickness: 0.25 }).slabId,
      addColumnToStore(editor, anchor, { GlobalId: guids[2], Position: [0, 0, 0], Width: 0.3, Depth: 0.3, Height: 3 }).columnId,
      addBeamToStore(editor, anchor, { GlobalId: guids[3], Start: [0, 0, 3], End: [4, 0, 3], Width: 0.2, Height: 0.4 }).beamId,
      addDoorToStore(editor, anchor, { GlobalId: guids[4], Position: [1, 0, 0], Width: 0.9, Height: 2.1 }).doorId,
      addWindowToStore(editor, anchor, { GlobalId: guids[5], Position: [2, 0, 1], Width: 1.2, Height: 1.4 }).windowId,
      addSpaceToStore(editor, anchor, { GlobalId: guids[6], Profile: 'rectangle', Position: [0, 0, 0], Width: 4, Depth: 3, Height: 2.8 }).spaceId,
      addRoofToStore(editor, anchor, { GlobalId: guids[7], Profile: 'rectangle', Position: [0, 0, 3], Width: 5, Depth: 4, Thickness: 0.2 }).roofId,
      addPlateToStore(editor, anchor, { GlobalId: guids[8], Profile: 'rectangle', Position: [0, 0, 0], Width: 2, Depth: 1, Thickness: 0.02 }).plateId,
      addMemberToStore(editor, anchor, { GlobalId: guids[9], Start: [0, 0, 0], End: [3, 0, 0], Width: 0.1, Height: 0.1 }).memberId,
    ];
    expect(ids.map(guidOf)).toEqual(guids);
    // Relationships and other emitted roots still get their own, valid, distinct GUIDs.
    const others = view.getNewEntities()
      .filter((e) => !ids.includes(e.expressId) && typeof e.attributes[0] === 'string' && isValidIfcGuid(e.attributes[0] as string))
      .map((e) => e.attributes[0] as string);
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((g) => guids.includes(g))).toBe(false);
  });

  it('the same GlobalId twice is the caller\'s decision, an omitted one is generated, a malformed one is refused', () => {
    const { editor, guidOf } = fresh();
    const g = generateIfcGuid();
    const a = addWallToStore(editor, anchor, { GlobalId: g, Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
    const b = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
    expect(guidOf(a)).toBe(g);
    expect(guidOf(b)).not.toBe(g);
    expect(isValidIfcGuid(guidOf(b) as string)).toBe(true);
    expect(() => addWallToStore(editor, anchor, { GlobalId: 'not-a-guid', Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 })).toThrow(/not a valid 22-character IFC GUID/);
  });
});
