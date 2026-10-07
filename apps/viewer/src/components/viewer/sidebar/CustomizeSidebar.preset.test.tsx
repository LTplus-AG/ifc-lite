/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ActivityBar } from './ActivityBar';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

it('#6926 Customize previews, applies and restores a coordinator layout through its existing controls', async () => {
  useViewerStore.setState({ sidebarActivePanel: 'properties', sidebarSecondaryPanel: null,
    sidebarCustomizing: true, sidebarMode: 'collapsed', sidebarWidthPct: 31, sidebarSplitRatio: 0.63, floatingPanels: [], poppedOutIds: [] });
  const before = useViewerStore.getState().serializeSidebarLayout();
  const ui = render(<ActivityBar />);
  await waitFor(() => [...ui.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Preview Coordinator review'), 'customizer and preset controls load on demand');
  const button = (label: string) => {
    const found = [...ui.querySelectorAll('button')].find(value => value.getAttribute('aria-label') === label || value.textContent?.trim() === label);
    assert.ok(found, `the existing customizer offers ${label}`);
    return found;
  };
  click(button('Preview Coordinator review'));
  assert.deepEqual(useViewerStore.getState().serializeSidebarLayout(), before, 'preview never mutates the layout');
  click(button('Apply Coordinator review'));
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'clash');
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'bcf');
  assert.deepEqual([...useViewerStore.getState().sidebarOrder].sort(), [...before.order].sort(), 'no tool disappears when applying the preset');
  const restore = button('Restore my layout');
  restore.focus();
  click(restore);
  assert.deepEqual(useViewerStore.getState().serializeSidebarLayout(), before);
  assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, null);
  assert.equal(useViewerStore.getState().sidebarSplitRatio, 0.63);
  assert.match(ui.querySelector('output[aria-live="polite"]')?.textContent ?? '', /previous layout is restored/);
  assert.equal(document.activeElement, button('Apply Coordinator review'), 'removing Restore keeps keyboard focus in the customizer');
});
