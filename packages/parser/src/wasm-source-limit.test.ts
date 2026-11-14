/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { assertWasmSourceSize, WasmSourceSizeError } from './wasm-source-limit.js';
it('refuses the wasm32 boundary before any source allocation (huge-file report)', () => {
  expect(() => assertWasmSourceSize(2 ** 31 - 1)).not.toThrow();
  for (const size of [2 ** 31, 2 ** 31 + 1]) {
    expect(() => assertWasmSourceSize(size)).toThrow(WasmSourceSizeError);
  }
});

// PR #9617: an invalid numeric size must never pass a safety guard.
it('rejects invalid sizes while accepting zero and integer byte counts', () => {
  for (const size of [NaN, Infinity, -Infinity, -1, -0.5, 0.5]) {
    expect(() => assertWasmSourceSize(size)).toThrow(RangeError);
    expect(() => assertWasmSourceSize(size)).toThrow(/finite non-negative integer/);
  }
  expect(() => assertWasmSourceSize(0)).not.toThrow();
  expect(() => assertWasmSourceSize(1)).not.toThrow();
});
