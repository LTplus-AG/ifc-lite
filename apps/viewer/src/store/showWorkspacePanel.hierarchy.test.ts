/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from './index.js';

const state = () => useViewerStore.getState();

it('showWorkspacePanel reveals hierarchy in the left slot without a right-pane copy (#8802, #1267)', () => {
  state().setLeftPanelCollapsed(true);
  state().showWorkspacePanel('properties');
  const dockedBefore = {
    primary: state().sidebarActivePanel,
    secondary: state().sidebarSecondaryPanel,
  };

  state().showWorkspacePanel('hierarchy');

  assert.equal(state().leftPanelCollapsed, false);
  const dockedAfter = {
    primary: state().sidebarActivePanel,
    secondary: state().sidebarSecondaryPanel,
  };
  assert.deepEqual(dockedAfter, dockedBefore);
  assert.equal(Object.values(dockedAfter).includes('hierarchy'), false);
  assert.equal(state().floatingPanels.some((panel) => panel.id === 'hierarchy'), false);
});
