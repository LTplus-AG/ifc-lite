/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { resolveLoadTessellationTier, AUTO_LOW_TIER_MB, AUTO_LOWEST_TIER_MB } from './constants.js';

// In node:test there is no `window`, so getGeomTierOverride() returns undefined
// and these assertions exercise the pure size + mode logic deterministically.
describe('resolveLoadTessellationTier (geometry mode gating)', () => {
  it('fast mode keeps medium (undefined) for small models', () => {
    assert.strictEqual(resolveLoadTessellationTier(10, 'fast'), undefined);
  });

  it('fast mode auto-lows at/above the low threshold', () => {
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOW_TIER_MB, 'fast'), 'low');
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB - 1, 'fast'), 'low');
  });

  it('fast mode drops to lowest at/above the lowest threshold', () => {
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB, 'fast'), 'lowest');
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB + 500, 'fast'), 'lowest');
  });

  it('exact mode never auto-lows, even for very large models', () => {
    assert.strictEqual(resolveLoadTessellationTier(10, 'exact'), undefined);
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOW_TIER_MB, 'exact'), undefined);
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB + 1000, 'exact'), undefined);
  });

  it('defaults to fast mode when omitted', () => {
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOW_TIER_MB), 'low');
  });
});
