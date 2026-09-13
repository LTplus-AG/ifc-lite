/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `closePanel` on a bottom panel clears its docked flag through the table's
 * setter (review finding on #3944: the charts panel's X could not close it
 * while the setter switch still named only the old trio).
 */
import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store/index.js';
import { usePanelControls, type PanelControls } from '@/hooks/usePanelControls.js';
import { render, cleanup } from '@/test/render.js';
import { BOTTOM_PANEL_IDS, bottomPanelFlags, isBottomPanelOpen } from './bottom-panels.js';

let controls: PanelControls | null = null;
function Probe() {
  controls = usePanelControls();
  return null;
}

describe('closePanel over every bottom panel', () => {
  afterEach(() => cleanup());

  it('clears exactly the closed panel flag', () => {
    for (const id of BOTTOM_PANEL_IDS) {
      useViewerStore.setState({ ...bottomPanelFlags(id), floatingPanels: [], poppedOutIds: [] });
      assert.equal(isBottomPanelOpen(useViewerStore.getState(), id), true);
      render(<Probe />);
      controls!.closePanel(id);
      assert.equal(isBottomPanelOpen(useViewerStore.getState(), id), false, id);
      cleanup();
    }
  });
});
