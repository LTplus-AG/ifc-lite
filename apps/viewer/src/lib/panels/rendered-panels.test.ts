/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Which panels are drawn, by the rules SidebarDock, SidebarPanelHost and ViewerLayout draw by (#8802 R6 review). */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dockedBottomPanel, renderedPanelIds, sidebarPaneContent, sidebarPaneDrawn, type RenderedPanelsInput } from './rendered-panels';
import { BOTTOM_PANEL_FLAG, BOTTOM_PANEL_IDS, type BottomPanelFlags, type BottomPanelId } from './bottom-panels';
import type { WorkspacePanelId } from './registry';

function flags(...open: BottomPanelId[]): BottomPanelFlags {
  return Object.fromEntries(BOTTOM_PANEL_IDS.map((id) => [BOTTOM_PANEL_FLAG[id], open.includes(id)])) as BottomPanelFlags;
}

const BASE: RenderedPanelsInput = {
  sidebarMode: 'expanded', paneFoldedForStart: false, rightExtensionActive: false,
  activePanel: 'lens', secondaryPanel: 'clash', leftSlotOpen: false,
  bottomFlags: flags(), floatingIds: new Set<WorkspacePanelId>(), poppedIds: new Set<WorkspacePanelId>(),
};
const drawn = (over: Partial<RenderedPanelsInput>) => [...renderedPanelIds({ ...BASE, ...over })].sort();

describe('rendered panels', () => {
  it('draws the pane only when expanded and not folded for the start screen', () => {
    assert.equal(sidebarPaneDrawn('expanded', false), true);
    assert.equal(sidebarPaneDrawn('collapsed', false), false);
    assert.equal(sidebarPaneDrawn('expanded', true), false);
  });

  it('counts the primary and split halves only while the pane is drawn', () => {
    assert.deepEqual(drawn({}), ['clash', 'lens']);
    assert.deepEqual(drawn({ sidebarMode: 'collapsed' }), [], 'a collapsed sidebar draws neither');
    assert.deepEqual(drawn({ paneFoldedForStart: true }), []);
    assert.deepEqual(drawn({ rightExtensionActive: true }), [], 'an analysis extension owns the pane');
  });

  it('shows Properties when the active panel is detached, and the split only beside a shown panel', () => {
    const detached = (ids: WorkspacePanelId[]) => (id: WorkspacePanelId) => ids.includes(id);
    assert.deepEqual(sidebarPaneContent('lens', 'clash', detached(['lens'])), { shown: 'properties', secondary: 'clash' });
    assert.deepEqual(sidebarPaneContent('lens', 'clash', detached(['lens', 'properties'])), { shown: null, secondary: null });
    assert.deepEqual(sidebarPaneContent('lens', 'lens', detached([])), { shown: 'lens', secondary: null });
  });

  it('docks only the first flagged bottom panel, and none when that one is detached', () => {
    assert.equal(dockedBottomPanel(flags('lists', 'charts'), () => false), 'lists');
    assert.deepEqual(drawn({ bottomFlags: flags('lists', 'charts'), sidebarMode: 'collapsed' }), ['lists'], 'a second flag is not drawn');
    assert.equal(dockedBottomPanel(flags('lists'), (id) => id === 'lists'), null);
  });

  it('counts the left slot, floating and popped-out windows', () => {
    assert.deepEqual(drawn({ sidebarMode: 'collapsed', leftSlotOpen: true, floatingIds: new Set<WorkspacePanelId>(['bcf']), poppedIds: new Set<WorkspacePanelId>(['lists']) }),
      ['bcf', 'hierarchy', 'lists']);
  });
});
