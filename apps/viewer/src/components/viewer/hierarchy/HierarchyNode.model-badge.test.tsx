/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { HierarchyNode } from './HierarchyNode.js';
import type { NodeType, TreeNode } from './types.js';

afterEach(cleanup);

function node(type: NodeType): TreeNode {
  return {
    id: `row-B-${type}`, expressIds: [7], globalIds: [1007], modelIds: ['B'], modelId: 'B',
    name: 'Wall', type, depth: 0, hasChildren: false, isExpanded: false, isVisible: true,
  };
}

function mount(type: NodeType, multi: boolean, ownership?: Pick<TreeNode, 'modelIds' | 'modelId'>): HTMLElement {
  const a = fixtureModel('A', { idOffset: 0 });
  const b = fixtureModel('B', { idOffset: 1000 });
  a.name = 'Architecture.ifc';
  b.name = 'Structure.ifc';
  useViewerStore.setState({ models: new Map(multi ? [['A', a], ['B', b]] : [['B', b]]) });
  return render(
    <HierarchyNode
      node={{ ...node(type), ...ownership }} virtualRow={{ size: 28, start: 0 }} isSelected={false} nodeHidden={false}
      isMultiModel={multi} modelsCount={multi ? 2 : 1}
      onNodeClick={() => {}} onToggleExpand={() => {}} onVisibilityToggle={() => {}}
      onModelVisibilityToggle={() => {}} onRemoveModel={() => {}} onModelHeaderClick={() => {}}
    />,
  );
}

describe('hierarchy source-model badge (#5888)', () => {
  for (const type of ['element', 'ifc-type', 'group', 'group-member', 'material-group'] as const) {
    it(`shows the same accessible model name for ${type} in a federation`, () => {
      const ui = mount(type, true);
      const badge = ui.querySelector('[role="note"][aria-label="Structure.ifc"]');
      assert.ok(badge, `${type} must identify its owning model`);
      assert.equal(ui.querySelector('.hierarchy-item')?.textContent?.includes('Wall [Structure.ifc]'), false);
    });
  }

  it('shows no badge for a single loaded model', () => {
    assert.equal(mount('element', false).querySelector('[role="note"]'), null);
  });

  it('does not assign a badge to a material from a composed store shared by layers', () => {
    assert.equal(mount('material-group', true, { modelIds: ['A', 'B'], modelId: undefined }).querySelector('[role="note"]'), null);
  });
});
