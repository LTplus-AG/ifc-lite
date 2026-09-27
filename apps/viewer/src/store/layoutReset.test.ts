/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5854 — one "Reset layout" resets the whole workspace, not just the
 * sidebar: floating panels (the ones that end up off screen) are cleared,
 * the hierarchy pane is expanded, and component-held layout (bottom strip
 * height, pane width) is told to reset through `layoutResetEpoch`.
 */
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getViewerStoreApi } from '@/store';
import {
  BOTTOM_STRIP_DEFAULT_HEIGHT,
  loadBottomStripHeight,
  persistBottomStripHeight,
} from '@/lib/panels/bottom-strip-persistence';

// Dynamic: the revert oracle deletes this module, and a static import would
// fail the whole file instead of letting the assertions go red.
let resetLayout: ((store?: ReturnType<typeof getViewerStoreApi>) => void) | undefined;
try {
  ({ resetLayout } = await import('./layoutReset.js'));
} catch (error) {
  console.error('[layoutReset.test] layoutReset unavailable; assertions will fail', error instanceof Error ? error.message : error);
}

describe('resetLayout (#5854)', () => {
  it('resets sidebar, floating panels, the hierarchy pane and component layout in one call', () => {
    assert.ok(resetLayout, 'store/layoutReset must export resetLayout');
    const store = getViewerStoreApi();
    const s = store.getState();
    s.floatPanel('compare');
    s.setFloatingPanelRect('compare', { x: 5000, y: 5000 });
    s.setSidebarMode('collapsed');
    s.setLeftPanelCollapsed(true);
    const epochBefore = store.getState().layoutResetEpoch ?? 0;

    resetLayout(store);

    const after = store.getState();
    assert.deepEqual(after.floatingPanels, [], 'floating panels are cleared');
    assert.equal(after.sidebarMode, 'expanded', 'sidebar is back to its default');
    assert.equal(after.leftPanelCollapsed, false, 'hierarchy pane is expanded');
    assert.equal(after.layoutResetEpoch, epochBefore + 1, 'component-held layout is told to reset');
  });
});

describe('resetLayout follow-ups (#5957)', () => {
  it('does not pop the hierarchy sheet open on mobile', () => {
    const store = getViewerStoreApi();
    store.getState().setIsMobile(true);
    store.getState().setLeftPanelCollapsed(true);
    try {
      resetLayout!(store);
      assert.equal(store.getState().leftPanelCollapsed, true, 'on mobile an expanded left panel is a sheet over the model');
    } finally {
      store.getState().setIsMobile(false);
      store.getState().setLeftPanelCollapsed(false);
    }
  });

  it('resets the persisted bottom-strip height even when no strip is mounted', () => {
    persistBottomStripHeight(420);
    resetLayout!(getViewerStoreApi());
    assert.equal(loadBottomStripHeight(), BOTTOM_STRIP_DEFAULT_HEIGHT, 'the next strip mount starts at the default height');
  });
});
