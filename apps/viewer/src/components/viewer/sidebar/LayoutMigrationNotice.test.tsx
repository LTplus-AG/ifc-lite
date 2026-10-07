/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, click, render, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { DEFAULT_SIDEBAR_ORDER } from '@/lib/panels/layout-migration';
import { LAYOUT_BACKUP_KEY, SIDEBAR_LAYOUT_KEY, loadSidebarLayout } from '@/lib/panels/layout-persistence';
import { SidebarDock } from './SidebarDock';
import { LayoutMigrationNotice } from './LayoutMigrationNotice';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); localStorage.clear(); });
const legacy = { order: ['clash', 'extension:custom', 'ids', 'properties'], hiddenIds: ['extension:custom'], mode: 'collapsed', widthPct: 30 };
const original = JSON.stringify(legacy);
function boot() {
  localStorage.setItem(SIDEBAR_LAYOUT_KEY, original);
  loadSidebarLayout();
  useViewerStore.getState().applySidebarLayout(legacy);
  return render(<LayoutMigrationNotice />);
}
function press(ui: HTMLElement, name: string) {
  const target = [...ui.querySelectorAll('button')].find(button => button.textContent === name);
  assert.ok(target, name);
  click(target);
}

test('#6927 native migration notice reveals renamed/unknown placements and Keep survives reload', () => {
  const ui = boot();
  press(ui, 'Show changes');
  assert.match(ui.textContent ?? '', /Renamed ids to Data validation/);
  assert.match(ui.textContent ?? '', /extension:custom/);
  press(ui, 'Keep layout');
  assert.equal(ui.querySelector('section'), null);
  const restored = loadSidebarLayout();
  assert.deepEqual(restored.pending, []);
  assert.deepEqual(restored.layout.preserved, [{ id: 'extension:custom', after: 'clash', hidden: true }]);
  assert.equal(JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY)!).raw, original);
});

test('#6927 Reset uses the native full-workspace reset and retains unknown placements and rollback', () => {
  const ui = boot();
  useViewerStore.getState().setSidebarMode('collapsed');
  const epoch = useViewerStore.getState().layoutResetEpoch;
  press(ui, 'Reset layout');
  assert.equal(ui.querySelector('section'), null);
  const state = useViewerStore.getState();
  assert.equal(state.layoutResetEpoch, epoch + 1);
  assert.deepEqual(state.sidebarOrder, [...DEFAULT_SIDEBAR_ORDER]);
  assert.ok(state.sidebarPreserved.some(placement => placement.id === 'extension:custom'));
  assert.equal(JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY)!).raw, original);
});


test('#6927 the native dock loads migration recovery controls only for a pending migration', async () => {
  localStorage.setItem(SIDEBAR_LAYOUT_KEY, original);
  loadSidebarLayout();
  useViewerStore.getState().applySidebarLayout(legacy);
  useViewerStore.getState().setSidebarMode('expanded');
  const ui = render(<SidebarDock />);
  await waitFor(() => [...ui.querySelectorAll('button')].some(button => button.textContent === 'Show changes'), 'native recovery controls load');
  press(ui, 'Show changes');
  assert.match(ui.textContent ?? '', /Renamed ids to Data validation/);
  press(ui, 'Keep layout');
  assert.equal([...ui.querySelectorAll('button')].some(button => button.textContent === 'Keep layout'), false);
  assert.deepEqual(loadSidebarLayout().pending, []);
  assert.equal(JSON.parse(localStorage.getItem(LAYOUT_BACKUP_KEY)!).raw, original);
});
