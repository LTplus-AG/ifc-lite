/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #8452: a copy batch resolves each source's effective storey once. */

import { expect, it, vi } from 'vitest';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcCreator } from '../ifc-creator.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { addStoreyInStore } from './storey/storey-add.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { copyBatchInStore } from './copy-batch.js';
import { parse, session } from './__test__/storey-fixtures.oracle.js';

const SPATIAL = ['IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES', 'IFCRELNESTS'];

it('resolves each root storey once per batch, before writing, whatever the copy count', async () => {
  const creator = new IfcCreator({ Name: 'Blank' });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const l1 = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const l2 = addStoreyInStore(s.store, s.editor, { Name: 'Level 2', Elevation: 4 }).storeyId;
  const walls = Array.from({ length: 6 }, (_, i) => addOrdinaryElementInStore(s.editor, (draft) => resolveSpatialAnchor(s.store, l1, draft.getMutationView()),
    { kind: 'wall', params: { Start: [0, i * 2, 0], End: [6, i * 2, 0], Thickness: 0.2, Height: 3 } }));
  const lookups = vi.spyOn(MutablePropertyView.prototype, 'getAttributeOverrideEntityIds');
  try {
    const copies = copyBatchInStore(s.store, s.editor, walls, [{ offset: [0, 20, 0] }, { targetStoreyId: l2 }]);
    // Each copied element used to rebuild its source's spatial context two to
    // four times: twelve copies here made at least 24 such lookups.
    expect(lookups.mock.calls.filter(([types, id]) => id === undefined && JSON.stringify(types) === JSON.stringify(SPATIAL))).toHaveLength(walls.length);
    expect(copies.map(copy => copy.storeyId)).toEqual([...walls.map(() => l1), ...walls.map(() => l2)]);
  } finally { lookups.mockRestore(); }
});
