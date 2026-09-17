/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makePlacementManifest, parsePlacementManifest, resolvePlacementManifest } from './manifest.js';

describe('placement exchange identity and precision (#4226)', () => {
  const source = new Map([['original', { sourceContentHash: 'source-a' }]]);
  const placements = new Map([['original', { translation: [10_000_000.001, -2, 3] as const,
    // Non-zero and off-origin, so the round-trip cannot pass by defaulting.
    rotation: { angle: 0.5235987755982988, pivot: [12.5, -7.25, 0] as const }, locked: true }]]);
  const manifest = () => makePlacementManifest(source, placements, 'frame-a');

  it('restores exact doubles against source identity after runtime ids change', () => {
    const parsed = parsePlacementManifest(JSON.stringify(manifest()));
    const restored = resolvePlacementManifest(parsed, new Map([['reloaded', { sourceContentHash: 'source-a' }]]), 'frame-a');
    assert.deepEqual(restored.get('reloaded'), placements.get('original'));
    assert.equal(restored.has('original'), false);
  });

  it('loads a record written before rotation existed as no rotation (#4869)', () => {
    // The exact bytes an older build wrote: no `rotation` key at all.
    const legacy = JSON.stringify({ version: 1, units: 'm', axes: 'engineering-z-up', frameKey: 'frame-a',
      models: [{ instanceId: 'original', sourceContentHash: 'source-a', translation: [1, 2, 3], locked: false }] });
    const parsed = parsePlacementManifest(legacy);
    assert.deepEqual(parsed.models[0].rotation, { angle: 0, pivot: [0, 0, 0] });
    const restored = resolvePlacementManifest(parsed, source, 'frame-a');
    assert.deepEqual(restored.get('original'),
      { translation: [1, 2, 3], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false });
  });

  it('writes no rotation key for an unrotated model, and rejects a malformed one', () => {
    const unrotated = makePlacementManifest(source,
      new Map([['original', { translation: [1, 2, 3] as const, rotation: { angle: 0, pivot: [9, 9, 9] as const }, locked: false }]]), 'frame-a');
    assert.equal('rotation' in JSON.parse(JSON.stringify(unrotated)).models[0], false);
    for (const rotation of [{ angle: 'x', pivot: [0, 0, 0] }, { angle: 1 }, { angle: Number.NaN, pivot: [0, 0, 0] }, null]) {
      const text = JSON.stringify({ version: 1, units: 'm', axes: 'engineering-z-up', frameKey: 'frame-a',
        models: [{ instanceId: 'a', sourceContentHash: null, translation: [0, 0, 0], rotation, locked: false }] });
      assert.throws(() => parsePlacementManifest(text), /rotation/i, `accepted ${JSON.stringify(rotation)}`);
    }
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
