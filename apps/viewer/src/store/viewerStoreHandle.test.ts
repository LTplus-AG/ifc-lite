/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { findStoreImportCycles } from '../../../../scripts/check-store-import-cycles.mjs';

const storeKey = '__ifc_lite_viewer_store__';
const globalStore = globalThis as typeof globalThis & Record<string, unknown>;
const savedStore = globalStore[storeKey];

delete globalStore[storeKey];
after(() => {
  if (savedStore === undefined) delete globalStore[storeKey];
  else globalStore[storeKey] = savedStore;
});

it('keeps store-entry modules cycle-free and reads the registered viewer store', async () => {
  // Check the real reachable import graph before loading the handle. When the
  // production change is reverted, this assertion fails on the two modules
  // that still import store/index; it does not fail because the new handle
  // file was removed and could not be imported.
  assert.deepEqual(findStoreImportCycles().offenders, []);

  const { getViewerState, peekViewerStore, registerViewerStore } = await import('./viewerStoreHandle.js');
  assert.equal(peekViewerStore(), undefined);
  assert.throws(() => getViewerState(), /viewer store read before/);

  const state = { marker: 'fake viewer state' };
  const fake = { getState: () => state };
  registerViewerStore(fake as unknown as Parameters<typeof registerViewerStore>[0]);

  assert.equal(peekViewerStore(), fake);
  assert.equal(getViewerState(), state);
});
