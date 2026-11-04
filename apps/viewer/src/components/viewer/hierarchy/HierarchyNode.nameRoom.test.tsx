/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5394: a storey row in the default ~260 px tree left its name about 15 px
 * ("0…", "D.. A"), because every other part of the row was fixed-width and the
 * name was the only part that could shrink. The rules pinned here, on the
 * rendered row:
 *  - the indent step is 10 px per level (16 before #5394, 12 before #8802);
 *  - the visibility toggle overlays the type icon instead of reserving a slot
 *    of its own while invisible;
 *  - the element-count badge yields below an 18rem tree (container query);
 *  - with a LongName, the primary Name is never capped to a fraction.
 * happy-dom has no layout; `tests/e2e/hierarchy-names.e2e.spec.ts` measures the
 * real row on a real model.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { HierarchyNode } from './HierarchyNode.js';
import type { TreeNode } from './types.js';

afterEach(cleanup);

function storey(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 's1', expressIds: [1], globalIds: [1], modelIds: ['legacy'],
    name: 'Dachgeschoss', type: 'IfcBuildingStorey', depth: 3,
    hasChildren: true, isExpanded: false, isVisible: true,
    storeyDisplayElevation: 2.7, elementCount: 56,
    ...overrides,
  } as TreeNode;
}

function mountRow(node: TreeNode, nodeHidden = false): HTMLElement {
  const container = render(
    <HierarchyNode
      node={node} virtualRow={{ size: 28, start: 0 }} isSelected={false} nodeHidden={nodeHidden}
      isMultiModel={false} modelsCount={1}
      onNodeClick={() => {}} onToggleExpand={() => {}} onVisibilityToggle={() => {}}
      onModelVisibilityToggle={() => {}} onRemoveModel={() => {}} onModelHeaderClick={() => {}}
    />,
  );
  const row = container.querySelector('.hierarchy-item');
  assert.ok(row, 'row renders');
  return row as HTMLElement;
}

describe('HierarchyNode leaves the storey name room (#5394)', () => {
  it('indents 10 px per level', () => {
    assert.equal(mountRow(storey()).style.paddingLeft, `${3 * 10 + 6}px`);
  });

  it('keeps the distinguishing end of a long name visible (#8802)', () => {
    const name = 'house - outer wall - house right';
    const row = mountRow(storey({ name, type: 'element', ifcType: 'IfcWall', hasChildren: false, storeyDisplayElevation: undefined, elementCount: undefined }));
    const tail = [...row.querySelectorAll('span')].find((s) => s.textContent === ' house right');
    assert.ok(tail, `the tail renders on its own: ${row.innerHTML}`);
    assert.ok(tail.className.split(/\s+/).includes('shrink-0'), 'the tail never shrinks');
    assert.ok(row.textContent?.includes(name), 'head and tail concatenate to the exact name');
  });

  it('overlays the visibility toggle on the type icon rather than reserving a slot', () => {
    const row = mountRow(storey());
    const toggle = row.querySelector('button[aria-label*="Dachgeschoss"]:not([aria-expanded])');
    assert.ok(toggle, 'the visibility toggle renders');
    assert.notEqual(toggle.parentElement, row, 'the toggle is not a flex item of the row');
    assert.ok(toggle.parentElement?.querySelector('[data-hierarchy-type-icon]'), 'it shares the type icon slot');
    const rowItems = [...row.children].filter((c) => c.tagName === 'BUTTON');
    assert.equal(rowItems.length, 1, 'only the expand chevron is a button-sized flex item');
  });

  it('keeps the toggle visible while the node is hidden', () => {
    const row = mountRow(storey({ isVisible: false }), true);
    const toggle = row.querySelector('button[aria-label*="Dachgeschoss"]:not([aria-expanded])');
    assert.ok(toggle?.className.split(/\s+/).includes('opacity-100'), 'hidden rows always show their toggle');
  });

  it('lets the element-count badge yield below an 18rem tree', () => {
    const row = mountRow(storey());
    const badge = row.querySelector('[data-hierarchy-count-badge]');
    assert.ok(badge, 'the count badge renders');
    const classes = badge.className.split(/\s+/);
    assert.ok(classes.includes('hidden') && classes.some((c) => c.startsWith('@2xs:')), `container-query yield: ${badge.className}`);
    assert.ok(row.parentElement?.className.split(/\s+/).includes('@container'), 'the full-width row wrapper is the query container');
  });

  it('never caps the primary Name to a fraction when a LongName is shown', () => {
    const row = mountRow(storey({ secondaryName: 'ACID00000002-0000-0000-0000-000000000000' }));
    const primary = [...row.querySelectorAll('span')].find((s) => s.textContent === 'Dachgeschoss');
    assert.ok(primary, 'the primary Name renders');
    assert.ok(!/max-w-\[\d+%\]/.test(primary.className), `no fractional cap: ${primary.className}`);
    assert.ok(primary.className.split(/\s+/).includes('shrink-0'), 'the Name keeps its width before the LongName');
  });

  it('keeps the IFC class suffix on an element that also carries a LongName (#8802)', () => {
    const element = { type: 'element', ifcType: 'IfcWall', hasChildren: false, storeyDisplayElevation: undefined, elementCount: undefined } as const;
    for (const secondaryName of [undefined, 'Exterior wall']) {
      const row = mountRow(storey({ ...element, name: 'W-01', secondaryName }));
      const suffix = row.querySelector('[data-hierarchy-class-suffix]');
      const label = secondaryName ? 'with' : 'without';
      assert.equal(suffix?.textContent ?? null, 'IfcWall', `the class suffix renders ${label} a LongName`);
      const classes = suffix?.className.split(/\s+/) ?? [];
      assert.equal(classes.includes('basis-0') && classes.includes('truncate'), true,
        `the suffix takes only leftover room and truncates first ${label} a LongName: ${suffix?.className ?? ''}`);
      assert.equal(suffix?.parentElement?.getAttribute('title')?.endsWith(' · IfcWall') ?? false, true,
        `the row title names the class ${label} a LongName`);
    }
  });
});
