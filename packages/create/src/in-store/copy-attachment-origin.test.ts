/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9352: a copy drawn unbound ("NextStoreyAbove") whose placement cannot be
 * read on its new storey is not left attached at a height that never
 * followed: its attachment is cleared and the copy is listed in
 * `unattachedTops`, as for an unreadable body.
 */

import { expect, it, vi } from 'vitest';

const unreadable = new Set<number>();
vi.mock('./storey/storey-attached.js', async (original) => {
  const actual = await original<typeof import('./storey/storey-attached.js')>();
  return {
    ...actual,
    attachedTopWorldOrigin: (...args: Parameters<typeof actual.attachedTopWorldOrigin>) =>
      (unreadable.has(args[1]) ? Number.NaN : actual.attachedTopWorldOrigin(...args)),
  };
});

const create = await import('../index.js');
const { IfcCreator } = await import('../ifc-creator.js');
const { addOrdinaryElementInStore } = await import('./ordinary-element.js');
const { resolveSpatialAnchor } = await import('./resolve-anchor.js');
const { parse, session } = await import('./__test__/storey-fixtures.oracle.js');

it('clears and reports an unbound copy whose placement cannot be read', async () => {
  const creator = new IfcCreator({ Name: 'Blank' });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const l1 = create.readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const source = addOrdinaryElementInStore(s.editor, (draft) => resolveSpatialAnchor(s.store, l1, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, 0], End: [6, 0, 0], Thickness: 0.2, Height: 3 } });
  const l2 = create.addStoreyInStore(s.store, s.editor, { Name: 'Level 2', Elevation: 4 }).storeyId;
  create.addStoreyInStore(s.store, s.editor, { Name: 'Level 3', Elevation: 7 });
  // Recorded unbound, as one drawn before any storey above existed.
  create.writeTopAttachment(s.view, source, create.NEXT_STOREY_ABOVE, 'relative');
  // Every id the copy can take is unreadable; the source keeps its own reading.
  const firstFree = Math.max(...[...s.view.getNewEntities()].map((e) => e.expressId)) + 1;
  for (let id = firstFree; id < firstFree + 400; id++) unreadable.add(id);
  const [copy] = create.copyBatchInStore(s.store, s.editor, [source], [{ targetStoreyId: l2 }]);
  expect(unreadable.has(copy.copyId)).toBe(true);
  expect(copy.unattachedTops).toEqual([{ copyId: copy.copyId, reason: expect.stringMatching(/placement cannot be read/) }]);
  expect(create.readTopAttachment(create.readStoreyInventory(s.store, s.view), copy.copyId)).toBeNull();
});
