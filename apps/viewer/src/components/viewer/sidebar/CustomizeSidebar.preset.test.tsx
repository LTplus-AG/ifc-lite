/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ActivityBar } from './ActivityBar';
import { openAssistant, useAssistantPlacement } from '@/lib/assistant/placement';
import { applyLayoutPreset, restoreLayoutBeforePreset, useLayoutPreset } from '@/store/layoutPreset';

const initial = useViewerStore.getState();
const placement = useAssistantPlacement.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); useAssistantPlacement.setState(placement); useLayoutPreset.setState({ record: null }); });

it('#6926 Coordinator restore retains the panel displaced by a split Assistant', () => {
  useViewerStore.setState({ sidebarActivePanel: 'properties', sidebarSecondaryPanel: 'bcf', isMobile: false, floatingPanels: [], poppedOutIds: [] });
  useAssistantPlacement.setState({ placement: 'split', displacedSecondary: null });
  openAssistant('properties');
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'assistant');
  assert.equal(useAssistantPlacement.getState().displacedSecondary, 'bcf');
  applyLayoutPreset('coordinator');
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'bcf');
  assert.equal(restoreLayoutBeforePreset(), true);
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'assistant');
  useViewerStore.getState().setSidebarSecondaryPanel(null);
  assert.equal(useViewerStore.getState().sidebarSecondaryPanel, 'bcf', 'leaving the restored Assistant returns its original displaced panel');
});

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
  click(button('Apply Coordinator review'));
  assert.ok([...ui.querySelectorAll('button')].some(value => value.textContent?.trim() === 'Restore my layout'));
  const reset = ui.querySelector('button[title="Reset workspace layout"]') ?? [...ui.querySelectorAll('button')].find(value => value.textContent?.trim() === 'Reset');
  assert.ok(reset);
  click(reset);
  await waitFor(() => ![...ui.querySelectorAll('button')].some(value => value.textContent?.trim() === 'Restore my layout'), 'Reset retires the native preset record');
  assert.equal(localStorage.getItem('ifc-lite:layout-preset-v1'), null, 'the prior layout cannot return after Reset and reload');
  click(ui.querySelector('[data-sidebar-customize-toggle]')!);
  await waitFor(() => [...ui.querySelectorAll('button')].some(value => value.getAttribute('aria-label') === 'Preview Coordinator review'), 'customizer reopened after Reset');
  assert.equal([...ui.querySelectorAll('button')].some(value => value.textContent?.trim() === 'Restore my layout'), false, 'the warm customizer also retires its previous native record');
});
