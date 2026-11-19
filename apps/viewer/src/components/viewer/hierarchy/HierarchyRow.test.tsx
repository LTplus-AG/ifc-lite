/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10535: a panel render with unchanged rows must not render them again,
 * and a row that skipped rendering must still reach the panel's latest
 * click handler with its own section and index.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState, type Dispatch, type SetStateAction } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { HierarchyRow, stableRowHandlers, type HierarchyRowCallbacks } from './HierarchyRow.js';
import { hierarchyRowActions } from './HierarchyRowActions.js';
import type { TreeNode } from './types.js';

afterEach(cleanup);

/** A row whose `name` reads are counted: HierarchyNode reads it on every render. */
function countedRow(): { node: TreeNode; reads: () => number } {
  let reads = 0;
  const node: TreeNode = new Proxy({
    id: 'storey-7', expressIds: [7], globalIds: [7], modelIds: ['legacy'], name: 'L1', type: 'IfcBuildingStorey',
    depth: 1, hasChildren: false, isExpanded: false, isVisible: true,
  } satisfies TreeNode, {
    get(target, key, receiver) {
      if (key === 'name') reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { node, reads: () => reads };
}

const noop = () => undefined;
function callbacks(click: HierarchyRowCallbacks['click']): HierarchyRowCallbacks {
  return { click, toggleExpand: noop, visibilityToggle: noop, action: noop, modelVisibilityToggle: noop,
    removeModel: noop, syncSourceModel: noop, modelHeaderClick: noop };
}

/** Mount one row inside a host whose re-render (and the row's selection) the test controls. */
function mountRow(node: TreeNode, handlers: HierarchyRowCallbacks) {
  let update: Dispatch<SetStateAction<{ tick: number; isSelected: boolean }>> = noop;
  function Panel() {
    const [state, set] = useState({ tick: 0, isSelected: false });
    update = set;
    return <HierarchyRow node={node} section="storeys" index={3} start={84} size={28} handlers={handlers}
      isSelected={state.isSelected} nodeHidden={false} isMultiModel={false} modelsCount={1}
      actions={hierarchyRowActions(node, true)} registerRow={noop} focusRow={noop} />;
  }
  const container = render(<Panel />);
  return {
    container,
    rerender: () => act(() => update((s) => ({ ...s, tick: s.tick + 1 }))),
    select: () => act(() => update((s) => ({ ...s, isSelected: true }))),
  };
}

describe('HierarchyRow (#10535)', () => {
  it('skips rendering when the panel re-renders with the same row, and renders when its state changes', () => {
    const { node, reads } = countedRow();
    const row = mountRow(node, stableRowHandlers({ current: callbacks(noop) }));
    const afterMount = reads();
    assert.ok(afterMount > 0, 'the row rendered its name');
    row.rerender();
    assert.equal(reads(), afterMount, 'an unchanged row is not rendered again');
    row.select();
    assert.ok(reads() > afterMount, 'a row whose selection changed renders');
  });

  it('a skipped row calls the latest click handler with its section and index', () => {
    const calls: string[] = [];
    const latest = { current: callbacks((n, _e, section, index) => calls.push(`first ${n.id} ${section} ${index}`)) };
    const row = mountRow(countedRow().node, stableRowHandlers(latest));
    latest.current = callbacks((n, _e, section, index) => calls.push(`latest ${n.id} ${section} ${index}`));
    row.rerender();
    click(row.container.querySelector('[role="treeitem"]')!);
    assert.deepEqual(calls, ['latest storey-7 storeys 3']);
  });
});
