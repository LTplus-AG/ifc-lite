/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5957 (from #5854): the Customize sidebar's Reset is a "Reset layout" entry
 * point, so it resets the whole workspace through the one `resetLayout()`,
 * floating panels included, not just the sidebar order.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { CustomizeSidebar } from './CustomizeSidebar';

afterEach(cleanup);

it('Reset clears floating panels and tells component layout to reset', () => {
  const s = useViewerStore.getState();
  s.floatPanel('compare');
  const epochBefore = useViewerStore.getState().layoutResetEpoch;
  assert.equal(useViewerStore.getState().floatingPanels.length, 1, 'precondition: one floating panel');

  const ui = render(<CustomizeSidebar onClose={() => {}} />);
  const reset = [...ui.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reset');
  assert.ok(reset, 'the Reset button renders');
  click(reset);

  const after = useViewerStore.getState();
  assert.deepEqual(after.floatingPanels, [], 'floating panels are cleared');
  assert.equal(after.layoutResetEpoch, epochBefore + 1, 'the bottom strip and hierarchy pane are told to reset');
});
