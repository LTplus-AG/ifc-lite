/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

type ColorMap = Map<number, [number, number, number, number]>;

function makeStore(): { store: StoreApi; getPending: () => ColorMap | null } {
  let pendingColorUpdates: ColorMap | null = null;
  const state = {
    // idOffset: 0 so toGlobalIdForRef(state.models, ref) === ref.expressId, matching the
    // expressId literals used by refA/refB below.
    models: new Map([['default', { idOffset: 0 }]]),
    get pendingColorUpdates() {
      return pendingColorUpdates;
    },
    setPendingColorUpdates: (updates: ColorMap) => {
      pendingColorUpdates = new Map(updates);
    },
  };
  const store = {
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as StoreApi;
  return { store, getPending: () => pendingColorUpdates };
}

const refA = { modelId: 'default', expressId: 1 };
const refB = { modelId: 'default', expressId: 2 };
const red: [number, number, number, number] = [1, 0, 0, 1];
const blue: [number, number, number, number] = [0, 0, 1, 1];

test('resetColors() with no argument still clears everything (regression guard)', () => {
  const { store, getPending } = makeStore();
  const adapter = createViewerAdapter(store);

  adapter.colorize([refA, refB], red);
  assert.equal(getPending()?.size, 2);

  adapter.resetColors();

  const pending = getPending();
  assert.ok(pending !== null, 'resetColors() must still emit a map (not null) to trigger the clear effect');
  assert.equal(pending?.size, 0, 'resetColors() with no refs must clear ALL overrides');
});

test('resetColors([a]) clears only a and leaves b intact', () => {
  const { store, getPending } = makeStore();
  const adapter = createViewerAdapter(store);

  adapter.colorize([refA], red);
  adapter.colorize([refB], blue);
  assert.equal(getPending()?.size, 2);

  adapter.resetColors([refA]);

  const pending = getPending();
  assert.equal(pending?.has(1), false, 'refA override must be gone');
  assert.equal(pending?.has(2), true, 'refB override must remain');
  assert.deepEqual(pending?.get(2), blue);
});

test('resetColors(refs) still works after the store has flushed pendingColorUpdates to null', () => {
  const { store, getPending } = makeStore();
  const adapter = createViewerAdapter(store);

  adapter.colorize([refA, refB], red);
  // Simulate the geometry-streaming effect flushing the update and clearing it —
  // this is exactly what happens between renders in the real app via clearPendingColorUpdates().
  Object.defineProperty(store.getState(), 'pendingColorUpdates', { value: null, configurable: true });

  adapter.resetColors([refA]);

  const pending = getPending();
  assert.equal(pending?.has(1), false, 'refA override must be gone even after a flush');
  assert.equal(pending?.has(2), true, 'refB override must survive the flush and the targeted reset');
});
