/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `NORMAL_COORD_THRESHOLD_M` — the 10 km "normal coordinate" ceiling.
 *
 * The TypeScript copies of this number are now one constant, so they cannot
 * drift from each other. What this file pins is the number ITSELF, because one
 * agreement is still held by prose alone and cannot be shared away: the Rust
 * fixture `rust/geometry/tests/issue_859_railway_renders_in_view.rs` declares
 * its own `const MAX_VALID_COORD: f32 = 10_000.0;` and asserts that welded
 * railway geometry lands inside it, explicitly "the JS-side renderer's
 * `MAX_VALID_COORD = 10 km`". If this side moves, that fixture keeps passing
 * against a threshold the renderer no longer uses, and geometry it certified as
 * visible would be filtered out of the camera-fit bounds.
 *
 * So: a change here is a change to a cross-language contract. Update the Rust
 * fixture in the same commit, then update this test.
 */

import { describe, it, expect } from 'vitest';
import { NORMAL_COORD_THRESHOLD_M } from './coordinate-handler.js';

describe('NORMAL_COORD_THRESHOLD_M', () => {
  it('is 10 km, the value the Rust visibility fixture is written against', () => {
    expect(NORMAL_COORD_THRESHOLD_M).toBe(10_000);
  });
});
