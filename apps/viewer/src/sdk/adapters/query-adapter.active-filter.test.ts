/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function makeStore(searchFilter: unknown): StoreApi {
  return {
    getState: () => ({ searchFilter, models: new Map() }),
    subscribe: () => () => {},
  } as unknown as StoreApi;
}

test('entitiesMatchingActiveFilter returns null when no filter rules are active', () => {
  const adapter = createQueryAdapter(makeStore({ rules: [], combinator: 'AND', limit: 500 }));
  // null (not []) so callers can distinguish "no filter" from "zero matches".
  assert.equal(adapter.entitiesMatchingActiveFilter(), null);
});

test('entitiesMatchingActiveFilter returns null when the filter state is absent', () => {
  const adapter = createQueryAdapter(makeStore(undefined));
  assert.equal(adapter.entitiesMatchingActiveFilter(), null);
});
