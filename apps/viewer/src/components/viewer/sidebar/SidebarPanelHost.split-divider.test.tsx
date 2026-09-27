/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5821: the split sidebar separator resizes from the keyboard and reports its live ratio. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { SidebarPanelHost } from './SidebarPanelHost.js';

afterEach(cleanup);

it('resizes the split sidebar with arrow and boundary keys while reporting its ratio (#5821)', () => {
  const initial = useViewerStore.getState();
  try {
    act(() => useViewerStore.setState({
      sidebarActivePanel: 'loadReport', sidebarSecondaryPanel: 'pointclouds',
      sidebarSplitRatio: 0.5, activeTool: 'select',
    }));
    const host = render(<SidebarPanelHost />);
    const separator = host.querySelector<HTMLElement>('[role="separator"]');
    assert.ok(separator);
    const upperPanel = separator.previousElementSibling as HTMLElement;
    assert.equal(separator.tabIndex, 0);
    assert.equal(separator.getAttribute('aria-orientation'), 'horizontal');
    assert.equal(separator.getAttribute('aria-valuemin'), '20');
    assert.equal(separator.getAttribute('aria-valuemax'), '80');
    assert.equal(separator.getAttribute('aria-valuenow'), '50');
    assert.equal(upperPanel.style.flexBasis, '50%');

    for (const [key, expected] of [
      ['ArrowUp', 45],
      ['ArrowDown', 50],
      ['Home', 20],
      ['ArrowUp', 20],
      ['End', 80],
      ['ArrowDown', 80],
    ] as const) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { separator.dispatchEvent(event); });
      assert.equal(event.defaultPrevented, true, `${key} is handled by the separator`);
      assert.equal(useViewerStore.getState().sidebarSplitRatio, expected / 100);
      assert.equal(separator.getAttribute('aria-valuenow'), String(expected));
      assert.equal(upperPanel.style.flexBasis, `${expected}%`);
    }
  } finally {
    cleanup();
    act(() => useViewerStore.setState({
      sidebarActivePanel: initial.sidebarActivePanel,
      sidebarSecondaryPanel: initial.sidebarSecondaryPanel,
      sidebarSplitRatio: initial.sidebarSplitRatio,
      activeTool: initial.activeTool,
    }));
  }
});
