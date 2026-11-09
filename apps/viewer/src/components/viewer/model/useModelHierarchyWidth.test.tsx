/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { useModelHierarchyWidth } from './useModelHierarchyWidth';

afterEach(() => { cleanup(); useViewerStore.setState({ workspaceMode: 'view', leftPanelCollapsed: false }); });

/** The panel's public percentage-size port; resize remains observable across mode changes. */
function panelAt(initial: number) {
  let width = initial, collapsed = false;
  const panel: PanelImperativeHandle = {
    getSize: () => ({ asPercentage: width, inPixels: width * 16 }),
    isCollapsed: () => collapsed,
    collapse: () => { collapsed = true; }, expand: () => { collapsed = false; },
    resize: (size) => { width = typeof size === 'number' ? size : Number.parseFloat(size); },
  };
  const ref = { current: panel };
  function Probe() { useModelHierarchyWidth(ref, false, 22.5); return null; }
  useViewerStore.setState({ workspaceMode: 'view', leftPanelCollapsed: false });
  render(<Probe />);
  return {
    panel, width: () => width,
    mode: (workspaceMode: 'view' | 'model') => act(() => useViewerStore.setState({ workspaceMode })),
    collapse: () => act(() => { panel.collapse(); useViewerStore.setState({ leftPanelCollapsed: true }); }),
    expand: () => act(() => { panel.expand(); useViewerStore.setState({ leftPanelCollapsed: false }); }),
  };
}

it('#9296 caps the hierarchy when it expands after entering Model', () => {
  const h = panelAt(25);
  h.collapse(); h.mode('model'); h.expand();
  assert.equal(h.width(), 18, 'the plan retains its room after expansion');
});
it('#9296 an unmeasured hierarchy gets a finite cap and restore width', () => {
  const h = panelAt(NaN);
  h.mode('model'); assert.equal(h.width(), 18);
  h.mode('view'); assert.equal(h.width(), 22.5);
});
it('#9296 exiting while collapsed forgets the previous session width', () => {
  const h = panelAt(25);
  h.mode('model'); h.collapse(); h.mode('view'); h.expand();
  h.panel.resize('30%');
  h.mode('model'); h.mode('view');
  assert.equal(h.width(), 30, 'restore the width chosen since the last Model session');
});
