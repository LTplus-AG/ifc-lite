/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createSidebarSlice } from './sidebarSlice';

const layoutKey = 'ifc-lite:sidebar-layout-v1';
const backupKey = 'ifc-lite:sidebar-layout-backup-v1';
afterEach(() => localStorage.clear());

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
