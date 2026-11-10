/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { wasmBytesScanAllowed } from './entity-scanner.js';

describe('wasmBytesScanAllowed', () => {
  it('allows typical large models', () => {
    expect(wasmBytesScanAllowed(883 * 1024 * 1024)).toBe(true);
    expect(wasmBytesScanAllowed(2_400_000_000)).toBe(false);
  });

  it('refuses sources beyond the wasm32 ceiling instead of trapping', () => {
    // A 3.9GB source cannot be copied into wasm32 linear memory alongside its
    // entity index; attempting it aborts with a bare `unreachable executed`
    // before the JS tokeniser fallback runs anyway (observed on a 3899MB IFC).
    expect(wasmBytesScanAllowed(3_899_000_000)).toBe(false);
    // Exactly 2.5e9 is refused, matching the geometry huge-file heuristic's
    // `>=` so the two ceilings agree at the boundary.
    expect(wasmBytesScanAllowed(2_500_000_000)).toBe(false);
  });
});

// Regression: huge-file report, wasm32 single-allocation boundary.
it('uses the exact exclusive wasm32 source boundary', () => {
  expect(wasmBytesScanAllowed(2 ** 31 - 1)).toBe(true);
  expect(wasmBytesScanAllowed(2 ** 31)).toBe(false);
  expect(wasmBytesScanAllowed(2 ** 31 + 1)).toBe(false);
});

// PR #9617: scan eligibility rejects invalid numeric sizes as well.
it('refuses non-finite, negative and fractional sizes', () => {
  for (const size of [NaN, Infinity, -Infinity, -1, -0.5, 0.5]) {
    expect(wasmBytesScanAllowed(size)).toBe(false);
  }
  expect(wasmBytesScanAllowed(0)).toBe(true);
  expect(wasmBytesScanAllowed(1)).toBe(true);
});
