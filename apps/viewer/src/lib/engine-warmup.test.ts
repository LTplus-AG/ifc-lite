/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY_PERF_FLAG_BINDINGS } from '@ifc-lite/geometry';
import { isWarmPoolEnabled } from './engine-warmup.js';

const globals = globalThis as Record<string, unknown>;
const flag = GEOMETRY_PERF_FLAG_BINDINGS.warmPool.global;
afterEach(() => { delete globals[flag]; });

test('#7048 main-thread warmup defaults off and accepts only explicit opt-in', () => {
  delete globals[flag];
  assert.equal(isWarmPoolEnabled(), false);
  for (const value of [0, '0', false, '', 'false']) {
    globals[flag] = value;
    assert.equal(isWarmPoolEnabled(), false);
  }
  for (const value of [1, '1', true]) {
    globals[flag] = value;
    assert.equal(isWarmPoolEnabled(), true);
  }
});
