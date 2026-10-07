/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createSidebarSlice } from './sidebarSlice';
import { defaultSidebarLayout } from '@/lib/panels/layout-migration';

const layoutKey = 'ifc-lite:sidebar-layout-v1';
const backupKey = 'ifc-lite:sidebar-layout-backup-v1';
afterEach(() => localStorage.clear());

test('#7054 importing a legacy profile backs up the customized v2 layout before its review notice', () => {
  const store = createStore(createSidebarSlice);
  store.getState().setSidebarWidthPct(37);
  store.getState().reorderSidebarPanel('clash', 0);
  store.getState().setPanelShownInSidebar('assistant', false);
  const original = localStorage.getItem(layoutKey);
  assert.ok(original);
  assert.equal(JSON.parse(original).version, 2);
  store.getState().applySidebarLayout({ order: ['ids', 'properties'], hiddenIds: [], mode: 'collapsed', widthPct: 24 });
  const backup = localStorage.getItem(backupKey);
  assert.ok(backup, 'the legacy import must capture the current layout before overwriting it');
  assert.equal(JSON.parse(backup).raw, original);
  assert.ok(store.getState().layoutMigrationChanges.some(change => change.kind === 'renamed'));
  assert.equal(JSON.parse(localStorage.getItem(layoutKey)!).widthPct, 24);
  store.getState().applySidebarLayout({ order: ['clash', 'ids'], mode: 'expanded', widthPct: 30 });
  assert.equal(JSON.parse(localStorage.getItem(backupKey)!).raw, original, 'another pending import retains the first rollback source');
});

test('#7054 a four-field v1 resize preserves both unknown and newly recognized panel anchors on re-upgrade', () => {
  const layout = defaultSidebarLayout();
  layout.order = ['hierarchy', 'assistant', 'clash', ...layout.order.filter(id => !['hierarchy', 'assistant', 'clash'].includes(id))];
  layout.hiddenIds = ['assistant'];
  layout.preserved = [{ id: 'extension:future', after: 'clash', hidden: true }];
  localStorage.setItem(layoutKey, JSON.stringify(layout));
  createStore(createSidebarSlice);
  // The deployed v1 serializer writes only these four fields after a resize.
  localStorage.setItem(layoutKey, JSON.stringify({ mode: 'collapsed', widthPct: 41,
    order: ['clash', ...layout.order.filter(id => id !== 'assistant' && id !== 'clash')], hiddenIds: [] }));
  const restored = createStore(createSidebarSlice).getState();
  assert.equal(restored.sidebarWidthPct, 41, 'the older build resize remains authoritative');
  assert.equal(restored.sidebarOrder[0], 'clash', 'the older build reorder remains authoritative');
  assert.equal(restored.sidebarOrder.indexOf('assistant'), restored.sidebarOrder.indexOf('hierarchy') + 1);
  assert.ok(restored.sidebarHiddenIds.includes('assistant'));
  assert.deepEqual(restored.sidebarPreserved, layout.preserved);
});

test('#6927 portable profile capture retains unknown placements through JSON export and import in another workspace', () => {
  const layout = defaultSidebarLayout();
  layout.preserved = [{ id: 'extension:future', after: 'clash', hidden: true }];
  localStorage.setItem(layoutKey, JSON.stringify(layout));
  const source = createStore(createSidebarSlice);
  const captured = JSON.stringify({ layout: { state: { sidebar: source.getState().serializeSidebarLayout() } } });
  localStorage.clear();
  const destination = createStore(createSidebarSlice);
  destination.getState().applySidebarLayout(JSON.parse(captured).layout.state.sidebar);
  assert.deepEqual(destination.getState().sidebarPreserved, layout.preserved);
  assert.deepEqual(JSON.parse(localStorage.getItem(layoutKey)!).preserved, layout.preserved);
});

test('#6927 native sidebar boot migrates retired names, preserves unknown placements and saves an exact rollback source', () => {
  const raw = JSON.stringify({ order: ['clash', 'extension:custom', 'ids', 'properties'], hiddenIds: ['extension:custom'], mode: 'collapsed', widthPct: 30 });
  localStorage.setItem(layoutKey, raw);
  const state = createStore(createSidebarSlice).getState();
  assert.ok(state.sidebarOrder.includes('validation'));
  assert.deepEqual(state.sidebarPreserved, [{ id: 'extension:custom', after: 'clash', hidden: true }]);
  assert.ok(state.layoutMigrationChanges.length > 0);
  assert.equal(JSON.parse(localStorage.getItem(backupKey)!).raw, raw);
  assert.equal(JSON.parse(localStorage.getItem(layoutKey)!).version, 2);
  state.acknowledgeLayoutMigration();
  const reloaded = createStore(createSidebarSlice).getState();
  assert.equal(reloaded.layoutMigrationChanges.length, 0);
  assert.deepEqual(reloaded.sidebarPreserved, state.sidebarPreserved);
  assert.equal(JSON.parse(localStorage.getItem(backupKey)!).raw, raw, 'Keep leaves the original rollback source intact');
});

test('#6927 denying the rollback write never overwrites the original layout', () => {
  const raw = JSON.stringify({ order: ['ids', 'properties'], mode: 'collapsed' });
  localStorage.setItem(layoutKey, raw);
  const original = localStorage.setItem.bind(localStorage);
  const warnings: unknown[] = [];
  const warn = console.warn;
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
    if (key === backupKey) throw new DOMException('Denied', 'SecurityError');
    original(key, value);
  } });
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const state = createStore(createSidebarSlice).getState();
    assert.ok(state.sidebarOrder.includes('validation'), 'the current session remains usable');
    assert.equal(localStorage.getItem(layoutKey), raw, 'no migrated write can destroy the unbacked original');
    state.setSidebarMode('expanded');
    state.acknowledgeLayoutMigration();
    state.setSidebarWidthPct(35);
    assert.equal(localStorage.getItem(layoutKey), raw, 'later edits and Keep cannot destroy the unbacked original');
    assert.ok(warnings.length > 0);
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); console.warn = warn; }
});

test('#6927 denied layout reads let the native sidebar boot with defaults and report the failure', () => {
  const warnings: unknown[] = [];
  const warn = console.warn;
  const original = localStorage.getItem.bind(localStorage);
  Object.defineProperty(localStorage, 'getItem', { configurable: true, value: () => { throw new DOMException('Denied', 'SecurityError'); } });
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const state = createStore(createSidebarSlice).getState();
    assert.ok(state.sidebarOrder.includes('properties'));
    assert.ok(state.sidebarOrder.includes('assistant'));
    assert.ok(warnings.length > 0);
  } finally { Object.defineProperty(localStorage, 'getItem', { configurable: true, value: original }); console.warn = warn; }
});


test('#6927 importing a legacy layout backs up the customized v2 state before its notice', () => {
  const store = createStore(createSidebarSlice);
  store.getState().setSidebarWidthPct(41);
  store.getState().setSidebarMode('collapsed');
  const original = localStorage.getItem(layoutKey)!;
  assert.equal(JSON.parse(original).version, 2);
  store.getState().applySidebarLayout({ order: ['ids', 'properties'], widthPct: 24 });
  assert.equal(JSON.parse(localStorage.getItem(backupKey)!).raw, original);
  assert.ok(store.getState().layoutMigrationChanges.length > 0);
  store.getState().acknowledgeLayoutMigration();
  localStorage.setItem(layoutKey, JSON.parse(localStorage.getItem(backupKey)!).raw);
  const recovered = createStore(createSidebarSlice).getState();
  assert.equal(recovered.sidebarWidthPct, 41);
  assert.equal(recovered.sidebarMode, 'collapsed');
  assert.deepEqual(recovered.sidebarOrder, JSON.parse(original).order);
});


test('#6927 a denied import backup leaves the current layout active through later saves', () => {
  const store = createStore(createSidebarSlice);
  store.getState().setSidebarWidthPct(41);
  const before = store.getState().sidebarOrder;
  const original = localStorage.setItem.bind(localStorage);
  const warn = console.warn;
  const warnings: unknown[] = [];
  Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
    if (key === backupKey) throw new DOMException('Denied', 'SecurityError');
    original(key, value);
  } });
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.throws(() => store.getState().applySidebarLayout({ order: ['ids', 'properties'], widthPct: 24 }), /Cannot import/);
    assert.deepEqual(store.getState().sidebarOrder, before);
    assert.equal(store.getState().sidebarWidthPct, 41);
    store.getState().setSidebarWidthPct(43);
    const reloaded = createStore(createSidebarSlice).getState();
    assert.deepEqual(reloaded.sidebarOrder, before);
    assert.equal(reloaded.sidebarWidthPct, 43);
    assert.equal(reloaded.layoutMigrationChanges.length, 0);
    assert.ok(warnings.length > 0);
  } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: original }); console.warn = warn; }
});


for (const retainCompanion of [false, true]) {
  test(`#7054 a rejected import cannot seed future rollback placements (companion=${retainCompanion})`, () => {
    const companionKey = 'ifc-lite:sidebar-layout-placements-v2';
    const store = createStore(createSidebarSlice);
    store.getState().setSidebarWidthPct(41);
    if (!retainCompanion) localStorage.removeItem(companionKey);
    const originalLayout = localStorage.getItem(layoutKey);
    const originalCompanion = localStorage.getItem(companionKey);
    const setItem = localStorage.setItem.bind(localStorage);
    const warn = console.warn;
    const warnings: unknown[] = [];
    Object.defineProperty(localStorage, 'setItem', { configurable: true, value: (key: string, value: string) => {
      if (key === layoutKey) throw new DOMException('Full', 'QuotaExceededError');
      setItem(key, value);
    } });
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      assert.throws(() => store.getState().applySidebarLayout({ order: ['bcf', 'extension:failed-import', 'properties'] }), /Cannot import/);
      assert.equal(localStorage.getItem(layoutKey), originalLayout);
      assert.equal(localStorage.getItem(companionKey), originalCompanion);
      assert.ok(warnings.length > 0);
    } finally { Object.defineProperty(localStorage, 'setItem', { configurable: true, value: setItem }); console.warn = warn; }
    // Simulate the already-released four-field writer, then return to this build.
    localStorage.setItem(layoutKey, JSON.stringify({ mode: 'collapsed', widthPct: 44, order: ['bcf', 'properties'], hiddenIds: [] }));
    const recovered = createStore(createSidebarSlice).getState();
    assert.equal(recovered.sidebarWidthPct, 44);
    assert.ok(!recovered.sidebarPreserved.some(placement => placement.id === 'extension:failed-import'));
  });
}
