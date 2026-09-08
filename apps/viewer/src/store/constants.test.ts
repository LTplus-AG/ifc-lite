/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  isPreviewTier,
  resolveLoadTessellationTier,
  AUTO_LOW_TIER_MB,
  AUTO_LOWEST_TIER_MB,
} from './constants.js';

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

describe('isPreviewTier', () => {
  // The set must stay in lockstep with `quality_skips_small_cuts` in
  // rust/geometry/src/processors/boolean/mod.rs (`Lowest | Low`). If a tier is
  // added to that Rust match without appearing here, `exact` mode silently
  // starts dropping small cuts again — the whole of #2544.
  it('is exactly the tiers below the engine default', () => {
    assert.strictEqual(isPreviewTier('lowest'), true);
    assert.strictEqual(isPreviewTier('low'), true);
    assert.strictEqual(isPreviewTier('medium'), false);
    assert.strictEqual(isPreviewTier('high'), false);
    assert.strictEqual(isPreviewTier('highest'), false);
  });

  it('treats "no override" as not a preview tier', () => {
    assert.strictEqual(isPreviewTier(undefined), false);
  });
});

// #2544: a `?geomTier=` override persists to localStorage from one link visit
// and used to win in EVERY mode, so `exact` silently served preview geometry
// (coarse curves AND dropped sub-10% cuts) while the UI promised full fidelity.
// The override is injected here rather than stubbing localStorage, which is
// also why `resolveLoadTessellationTier` takes it as a parameter.
describe('resolveLoadTessellationTier (stored ?geomTier= override)', () => {
  it('exact mode refuses a preview override, at any file size', () => {
    for (const tier of ['low', 'lowest'] as const) {
      assert.strictEqual(resolveLoadTessellationTier(10, 'exact', tier), undefined);
      assert.strictEqual(resolveLoadTessellationTier(76.73, 'exact', tier), undefined);
      assert.strictEqual(
        resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB + 1000, 'exact', tier),
        undefined,
      );
    }
  });

  it('exact mode still honours a medium-or-finer override', () => {
    // Pinning full density on a large model is why the override exists, and it
    // cannot violate the exact contract — so it must survive the fix.
    assert.strictEqual(resolveLoadTessellationTier(200, 'exact', 'high'), 'high');
    assert.strictEqual(resolveLoadTessellationTier(200, 'exact', 'highest'), 'highest');
    assert.strictEqual(resolveLoadTessellationTier(200, 'exact', 'medium'), 'medium');
  });

  it('fast mode still lets any override win over the size heuristic', () => {
    // Fast is the tuning mode; the override is a knob there, not a trap.
    assert.strictEqual(resolveLoadTessellationTier(10, 'fast', 'lowest'), 'lowest');
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOWEST_TIER_MB, 'fast', 'high'), 'high');
  });

  it('falls back to the size heuristic when no override is stored', () => {
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOW_TIER_MB, 'fast', undefined), 'low');
    assert.strictEqual(resolveLoadTessellationTier(AUTO_LOW_TIER_MB, 'exact', undefined), undefined);
  });
});
