/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Customize lists only the panels the host left on (`lib/features`), but the
 * store keeps every panel's place. A move must land next to the panel it was
 * moved past, even when a switched-off panel sits between them in the order.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { CustomizeSidebar } from './CustomizeSidebar';

afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.getState().resetSidebarLayout();
});

it('moves a panel past its visible neighbour when a switched-off panel lies between them', () => {
  // compare (on), bcf (off), lens (on): Customize shows compare, lens.
  useViewerStore.setState({ sidebarOrder: ['properties', 'compare', 'bcf', 'lens'], sidebarHiddenIds: [] });
  resetFeaturesForTest({ default: 'all', disable: ['check.bcf'] });
  const ui = render(<CustomizeSidebar onClose={() => {}} />);
  const down = ui.querySelector<HTMLButtonElement>('button[aria-label="Move Compare models down"]');
  assert.ok(down, 'Compare has a move-down button');
  click(down);
  const order = useViewerStore.getState().sidebarOrder;
  assert.ok(order.indexOf('compare') > order.indexOf('lens'), `Compare moved below Lens (order: ${order.join(', ')})`);
});
