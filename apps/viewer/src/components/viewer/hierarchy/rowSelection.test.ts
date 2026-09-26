/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hierarchyRowSelection } from './rowSelection.js';
import type { TreeNode } from './types.js';

const models = new Map([['A', { idOffset: 0 }], ['B', { idOffset: 1000 }]]);
const resolve = (globalId: number) => globalId >= 1000
  ? { modelId: 'B', expressId: globalId - 1000 }
  : { modelId: 'A', expressId: globalId };

function node(overrides: Partial<TreeNode>): TreeNode {
  return {
    id: 'row', type: 'element', name: 'Row', depth: 0, hasChildren: false,
    isExpanded: false, isVisible: true, expressIds: [], globalIds: [], modelIds: [],
    ...overrides,
  };
}

describe('hierarchy row selection (#5885)', () => {
  it('selects the actual class members from both models, not substituted assembly geometry', () => {
    const row = node({ type: 'type-group', expressIds: [7, 7], modelIds: [],
      memberGlobalIds: [7, 1007], globalIds: [8, 1008] });
    assert.deepEqual(hierarchyRowSelection(row, models, resolve), [
      { globalId: 7, modelId: 'A', expressId: 7 },
      { globalId: 1007, modelId: 'B', expressId: 7 },
    ]);
  });

  it('selects material and group members instead of their descriptor entity', () => {
    const material = node({ type: 'material-group', entityExpressId: 50,
      globalIds: [7, 1007], modelIds: ['A', 'B'] });
    assert.deepEqual(hierarchyRowSelection(material, models, resolve).map((item) => item.globalId), [7, 1007]);
    const group = node({ type: 'group', entityExpressId: 50,
      globalIds: [8, 1008], memberGlobalIds: [7, 1007], modelIds: ['A', 'B'] });
    assert.deepEqual(hierarchyRowSelection(group, models, resolve).map((item) => item.globalId), [7, 1007]);
  });

  it('keeps equal local storey IDs distinct in a two-model unified row', () => {
    const row = node({ type: 'unified-storey', expressIds: [5, 5], modelIds: ['A', 'B'] });
    assert.deepEqual(hierarchyRowSelection(row, models, resolve), [
      { globalId: 5, modelId: 'A', expressId: 5 },
      { globalId: 1005, modelId: 'B', expressId: 5 },
    ]);
  });
});
