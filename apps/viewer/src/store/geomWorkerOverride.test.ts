/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9659 review: a remembered `geomWorkers` must keep its old meaning (the
 * engine's memory budget clips it); only `?geomWorkers=N` in this page's URL
 * is a fresh request that may spend the budget's headroom.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GEOM_WORKERS_STORAGE_KEY, getGeomWorkerOverrideRequest } from './geomWorkerOverride.js';

afterEach(() => {
  localStorage.removeItem(GEOM_WORKERS_STORAGE_KEY);
  window.history.replaceState(null, '', '/');
});

describe('getGeomWorkerOverrideRequest', () => {
  it('a value only remembered in localStorage stays a plain, budget-clipped number', () => {
    localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, '8');
    assert.equal(getGeomWorkerOverrideRequest(), 8);
  });

  it('?geomWorkers=N in the current URL is an explicit beyond-budget request', () => {
    window.history.replaceState(null, '', '/?geomWorkers=6');
    assert.deepEqual(getGeomWorkerOverrideRequest(), { count: 6, beyondBudget: true });
    // ...and is remembered, but a later page without the param gets the clipped meaning back.
    window.history.replaceState(null, '', '/');
    assert.equal(getGeomWorkerOverrideRequest(), 6);
  });

  it('no override, or ?geomWorkers=auto, leaves the policy alone', () => {
    assert.equal(getGeomWorkerOverrideRequest(), undefined);
    localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, '4');
    window.history.replaceState(null, '', '/?geomWorkers=auto');
    assert.equal(getGeomWorkerOverrideRequest(), undefined);
  });
});
