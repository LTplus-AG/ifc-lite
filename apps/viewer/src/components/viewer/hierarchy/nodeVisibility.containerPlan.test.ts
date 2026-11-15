/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10214: a container-plan row with nothing to bring back acts on that row alone. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FederatedModel } from '@/store';
import { hierarchyNodeVisibility, hierarchyToggleTargets } from './nodeVisibility';
import type { TreeNode } from './types';

describe('hierarchy eye on a container-plan row (#10214)', () => {
  it('offers Show for a row that is an object hidden on its own, holding nothing else that is on', () => {
    // A stamped storey row standing for its own object, which Rhino hides on its own.
    const plan = { rows: new Map([[5, { children: [], members: [] }]]), ownOff: new Set<number>(), selfOff: new Set([5]) };
    const models = new Map([['m', { id: 'm', idOffset: 0, containerVisibility: plan } as unknown as FederatedModel]]);
    const node = { id: 'storey-5', type: 'IfcBuildingStorey', expressIds: [5], modelIds: ['m'], globalIds: [5] } as unknown as TreeNode;
    const hidden = new Set([5]);

    // A stamped building or site row holds no object directly: no direct elements.
    const { visibilityAction, nodeHidden } = hierarchyNodeVisibility(node, [], hidden, models);
    assert.equal(visibilityAction, 'show', 'not a Hide that would do nothing');
    assert.equal(nodeHidden, true);
    assert.deepEqual(hierarchyToggleTargets(node, [], 'show', models), [5]);
  });
});
