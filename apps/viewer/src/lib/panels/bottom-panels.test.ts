/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip is single-tenant and table-driven (#3944): the store's
 * three entry points (`toggleBottomPanel`, `openPanelInHome`,
 * `showWorkspacePanel`) must each leave EXACTLY the requested panel's flag on
 * for every id in the table, and the strip's precedence rule must be the one
 * the store, the mobile sheet and the tour snapshot all read. These are the
 * behaviours that used to be re-derived by hand in six places.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store/index.js';
import { WORKSPACE_PANELS } from './registry.js';
import {
  BOTTOM_PANEL_FLAG,
  BOTTOM_PANEL_IDS,
  activeBottomPanel,
  bottomPanelFlags,
  isBottomPanel,
  isBottomPanelOpen,
} from './bottom-panels.js';

describe('bottom-panel table', () => {
  it('lists exactly the registry panels whose home region is the bottom strip', () => {
    const fromRegistry = WORKSPACE_PANELS.filter((p) => p.region === 'bottom').map((p) => p.id).sort();
    assert.deepEqual([...BOTTOM_PANEL_IDS].sort(), fromRegistry);
    for (const p of WORKSPACE_PANELS) assert.equal(isBottomPanel(p.id), p.region === 'bottom', p.id);
  });

  it('builds a patch with exactly one flag on, and none on for null', () => {
    for (const id of BOTTOM_PANEL_IDS) {
      const patch = bottomPanelFlags(id);
      assert.equal(Object.keys(patch).length, BOTTOM_PANEL_IDS.length);
      assert.deepEqual(
        Object.entries(patch).filter(([, on]) => on).map(([flag]) => flag),
        [BOTTOM_PANEL_FLAG[id]],
      );
      assert.equal(activeBottomPanel(patch), id);
      assert.equal(isBottomPanelOpen(patch, id), true);
    }
    assert.equal(activeBottomPanel(bottomPanelFlags(null)), null);
  });

  it('resolves a doubly-set state by table precedence, so every reader agrees', () => {
    const flags = { ...bottomPanelFlags(null), [BOTTOM_PANEL_FLAG.lists]: true, [BOTTOM_PANEL_FLAG.script]: true };
    assert.equal(activeBottomPanel(flags), 'script');
  });
});

describe('store bottom-strip actions (#3944)', () => {
  beforeEach(() => {
    useViewerStore.setState({ ...bottomPanelFlags(null), floatingPanels: [], poppedOutIds: [], rightPanelCollapsed: true });
  });

  const openFlags = () =>
    BOTTOM_PANEL_IDS.filter((id) => isBottomPanelOpen(useViewerStore.getState(), id));

  it('toggleBottomPanel docks exactly the requested panel, then closes it on the second call', () => {
    for (const id of BOTTOM_PANEL_IDS) {
      useViewerStore.getState().toggleBottomPanel(id);
      assert.deepEqual(openFlags(), [id]);
      assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
    }
    // The last one is open; toggling it closes the strip.
    const last = BOTTOM_PANEL_IDS[BOTTOM_PANEL_IDS.length - 1];
    useViewerStore.getState().toggleBottomPanel(last);
    assert.deepEqual(openFlags(), []);
  });

  it('openPanelInHome and showWorkspacePanel each dock exactly the requested panel', () => {
    for (const id of BOTTOM_PANEL_IDS) {
      useViewerStore.getState().openPanelInHome(id);
      assert.deepEqual(openFlags(), [id]);
    }
    for (const id of BOTTOM_PANEL_IDS) {
      useViewerStore.getState().showWorkspacePanel(id);
      assert.deepEqual(openFlags(), [id]);
    }
  });

  it('toggling a floating bottom panel re-docks it instead of closing it', () => {
    const [id] = BOTTOM_PANEL_IDS;
    useViewerStore.getState().toggleBottomPanel(id);
    useViewerStore.getState().floatPanel(id);
    assert.ok(useViewerStore.getState().floatingPanels.some((p) => p.id === id));
    useViewerStore.getState().toggleBottomPanel(id);
    assert.deepEqual(openFlags(), [id]);
    assert.equal(useViewerStore.getState().floatingPanels.some((p) => p.id === id), false);
  });
});
