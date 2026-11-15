/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import {
  getViewerState,
  peekViewerStore,
  registerViewerStore,
} from './viewerStoreHandle.js';

const storeKey = '__ifc_lite_viewer_store__';
const globalStore = globalThis as typeof globalThis & Record<string, unknown>;
const savedStore = globalStore[storeKey];

delete globalStore[storeKey];
after(() => {
  if (savedStore === undefined) delete globalStore[storeKey];
  else globalStore[storeKey] = savedStore;
});

it('reads the registered viewer store without importing the store entry', () => {
  assert.equal(peekViewerStore(), undefined);
  assert.throws(() => getViewerState(), /viewer store read before/);

  const state = { marker: 'fake viewer state' };
  const fake = { getState: () => state };
  registerViewerStore(fake as Parameters<typeof registerViewerStore>[0]);

  assert.equal(peekViewerStore(), fake);
  assert.equal(getViewerState(), state);
});
