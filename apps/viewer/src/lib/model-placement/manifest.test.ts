/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePlacementManifest, parsePlacementManifest, resolvePlacementManifest } from './manifest.js';

describe('placement exchange identity and precision (#4226)', () => {
  const source = new Map([['original', { sourceContentHash: 'source-a' }]]);
  const placements = new Map([['original', { translation: [10_000_000.001, -2, 3] as const, locked: true }]]);
  const manifest = () => makePlacementManifest(source, placements, 'frame-a');

  it('restores exact doubles against source identity after runtime ids change', () => {
    const parsed = parsePlacementManifest(JSON.stringify(manifest()));
    const restored = resolvePlacementManifest(parsed, new Map([['reloaded', { sourceContentHash: 'source-a' }]]), 'frame-a');
    assert.deepEqual(restored.get('reloaded'), placements.get('original'));
    assert.equal(restored.has('original'), false);
  });

  it('refuses changed frames, changed source bytes, and ambiguous duplicate instances', () => {
    assert.throws(() => resolvePlacementManifest(manifest(), source, 'other-frame'), /coordinate frame/);
    assert.throws(() => resolvePlacementManifest(manifest(), new Map([['original', { sourceContentHash: 'different' }]]), 'frame-a'), /missing or ambiguous/);
    const duplicates = new Map([['a', { sourceContentHash: 'source-a' }], ['b', { sourceContentHash: 'source-a' }]]);
    assert.throws(() => resolvePlacementManifest(manifest(), duplicates, 'frame-a'), /ambiguous/);
    const restored = resolvePlacementManifest(manifest(), duplicates, 'frame-a', new Map([['original', 'b']]));
    assert.deepEqual([...restored.keys()], ['b']);
  });

  it('validates all entries before exposing a partially imported group', () => {
    for (const invalid of [
      { ...manifest(), version: 2 }, { ...manifest(), units: 'mm' },
      { ...manifest(), models: [{ ...manifest().models[0], translation: [Number.POSITIVE_INFINITY, 0, 0] }] },
      { ...manifest(), models: [manifest().models[0], manifest().models[0]] },
    ]) assert.throws(() => parsePlacementManifest(JSON.stringify(invalid)));
    assert.throws(() => parsePlacementManifest(JSON.stringify(manifest()).replace('10000000.001', '1e400')), /Invalid/);
    assert.throws(() => parsePlacementManifest(' '.repeat(2_000_001)), /2 MB/);
  });
});
