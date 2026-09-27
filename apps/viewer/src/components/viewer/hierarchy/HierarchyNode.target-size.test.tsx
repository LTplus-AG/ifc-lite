/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5826: the hierarchy rows' icon-only buttons (model header: reposition,
 * hide, sync, remove; element row: expand/collapse chevron and the
 * hover-revealed visibility toggle) must reach the WCAG 2.2 2.5.8 minimum of
 * 24x24 CSS px and show a focus ring (2.4.7).
 *
 * A 14px icon with `p-0.5` (2px) renders an 18px box; `p-[5px]` makes it
 * 14 + 2*5 = 24. The type-icon slot's toggle grows its `absolute` box by
 * `-inset-[5px]` instead. Padding and inset are class strings, so this asserts
 * the class rather than a computed layout: happy-dom has no layout engine,
 * and the Playwright spec in tests/e2e measures the real boxes. This test
 * fails on `main`, where every one of these buttons still carries `p-0.5` and
 * no `focus-visible:ring` class.
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

const virtualRow = { size: 28, start: 0 };

function baseNode(overrides: Partial<TreeNode>): TreeNode {
  return {
    id: 'n1',
    expressIds: [1],
    globalIds: [1],
    modelIds: ['legacy'],
    name: 'Row',
    type: 'element',
    depth: 1,
    hasChildren: false,
    isExpanded: false,
    isVisible: true,
    ...overrides,
  };
}

function mountRow(node: TreeNode): HTMLElement {
  return render(
    <HierarchyNode
      node={node}
      virtualRow={virtualRow}
      isSelected={false}
      nodeHidden={false}
      isMultiModel
      modelsCount={2}
      onNodeClick={() => {}}
      onToggleExpand={() => {}}
      onVisibilityToggle={() => {}}
      onModelVisibilityToggle={() => {}}
      onRemoveModel={() => {}}
      onModelHeaderClick={() => {}}
    />,
  );
}

function iconButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter(
    (button) => button.textContent?.trim() === '' || button.querySelector('svg'),
  );
}

/** `p-[5px]` grows a 14px icon to 24px; `-inset-[5px]` does the same for an absolute slot. */
function reachesMinimumTarget(button: HTMLButtonElement): boolean {
  const classes = button.className;
  return /(?:^|\s)p-\[5px\](?:\s|$)/.test(classes) || /(?:^|\s)-inset-\[5px\](?:\s|$)/.test(classes);
}

function hasFocusRing(button: HTMLButtonElement): boolean {
  return button.className.includes('focus-visible:ring-1');
}

describe('hierarchy icon buttons reach 24px and show a focus ring (#5826)', () => {
  it('model header row: every icon-only button', () => {
    const container = mountRow(
      baseNode({ type: 'model-header', name: 'A.ifc', depth: 0, hasChildren: true, modelIds: ['A'] }),
    );
    const buttons = iconButtons(container);
    assert.ok(buttons.length >= 2, `expected the header's icon buttons, got ${buttons.length}`);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.title;
      assert.ok(reachesMinimumTarget(button), `${name}: 24px target via p-[5px], got "${button.className}"`);
      assert.ok(hasFocusRing(button), `${name}: focus-visible ring, got "${button.className}"`);
      assert.ok(!/(?:^|\s)p-0\.5(?:\s|$)/.test(button.className), `${name}: still the 18px p-0.5 box`);
    }
  });

  it('element row: the expand chevron and the visibility toggle', () => {
    const container = mountRow(baseNode({ hasChildren: true, ifcType: 'IfcWall' }));
    const buttons = iconButtons(container);
    assert.ok(buttons.length >= 2, `expected chevron and visibility toggle, got ${buttons.length}`);
    for (const button of buttons) {
      const name = button.getAttribute('aria-label') ?? button.title;
      assert.ok(reachesMinimumTarget(button), `${name}: 24px target, got "${button.className}"`);
      assert.ok(hasFocusRing(button), `${name}: focus-visible ring, got "${button.className}"`);
    }
  });
});
