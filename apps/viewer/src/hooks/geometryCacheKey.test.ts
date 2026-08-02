/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildGeometryCacheKey } from './geometryCacheKey.js';

describe('buildGeometryCacheKey', () => {
  it('folds size, fingerprint and format version into the key', () => {
    const key = buildGeometryCacheKey(1024, 'abc123', false, 7);
    assert.strictEqual(key, 'ifc-1024-abc123-v7');
  });

  it('omits the merge-layers discriminator when merging is off (preserves legacy default-off entries)', () => {
    const key = buildGeometryCacheKey(2048, 'deadbeef', false, 5);
    assert.ok(!key.includes('-ml'), `expected no merge suffix, got ${key}`);
  });

  it('appends a merge-layers discriminator when merging is on', () => {
    const key = buildGeometryCacheKey(2048, 'deadbeef', true, 5);
    assert.strictEqual(key, 'ifc-2048-deadbeef-v5-ml');
  });

  it('produces distinct keys for the two merge-layers states (issue #1107: toggle+reload must miss)', () => {
    const off = buildGeometryCacheKey(4096, 'feed', false, 5);
    const on = buildGeometryCacheKey(4096, 'feed', true, 5);
    assert.notStrictEqual(off, on);
  });

  it('keeps the key filename-safe for the desktop Tauri cache backend ([A-Za-z0-9_-])', () => {
    const key = buildGeometryCacheKey(99, 'a1b2c3', true, 5);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });

  it('omits the skip-small-cuts discriminator by default (preserves legacy full-cut entries)', () => {
    const unset = buildGeometryCacheKey(2048, 'deadbeef', false, 5);
    const off = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    assert.strictEqual(unset, 'ifc-2048-deadbeef-v5');
    assert.strictEqual(off, 'ifc-2048-deadbeef-v5');
  });

  it('appends a skip-small-cuts discriminator when on (#1286: skipped display cache must not collide with full-cut)', () => {
    const skip = buildGeometryCacheKey(2048, 'deadbeef', false, 5, true);
    const full = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    assert.strictEqual(skip, 'ifc-2048-deadbeef-v5-sc');
    assert.notStrictEqual(skip, full);
  });

  it('composes the merge-layers and skip-small-cuts discriminators and stays filename-safe', () => {
    const key = buildGeometryCacheKey(4096, 'feed', true, 5, true);
    assert.strictEqual(key, 'ifc-4096-feed-v5-ml-sc');
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });

  it('omits the tessellation-tier discriminator at the medium default (preserves legacy entries)', () => {
    const unset = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    const medium = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'medium');
    assert.strictEqual(unset, 'ifc-2048-deadbeef-v5');
    assert.strictEqual(medium, 'ifc-2048-deadbeef-v5');
  });

  it('appends a tessellation-tier discriminator for a non-default tier (auto-low must not collide with medium)', () => {
    const low = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'low');
    const medium = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'medium');
    assert.strictEqual(low, 'ifc-2048-deadbeef-v5-tlow');
    assert.notStrictEqual(low, medium);
  });

  it('produces distinct keys per tier so different densities cache separately', () => {
    const low = buildGeometryCacheKey(4096, 'feed', false, 5, false, 'low');
    const lowest = buildGeometryCacheKey(4096, 'feed', false, 5, false, 'lowest');
    assert.notStrictEqual(low, lowest);
  });

  it('composes all discriminators and stays filename-safe', () => {
    const key = buildGeometryCacheKey(4096, 'feed', true, 5, true, 'lowest');
    assert.strictEqual(key, 'ifc-4096-feed-v5-ml-sc-tlowest');
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });
});
