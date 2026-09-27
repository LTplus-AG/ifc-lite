/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeSourceFingerprint } from '@ifc-lite/cache';
import { buildGeometryCacheKey } from './geometryCacheKey.js';

/**
 * Reference implementation of the OLD, weak fingerprint the current
 * `computeSourceFingerprint` (`@ifc-lite/cache`, moved from this hook in
 * #5138 PR 7b review) replaced: FNV-1a over the first 4KB + last 4KB, 32
 * bits, ignoring the entire interior of the file. Kept here ONLY to prove
 * the strengthened fingerprint changes the resulting cache key where the
 * old one would not have. The fingerprint math itself is covered in
 * `@ifc-lite/cache`'s `source-fingerprint.test.ts`; this integration test
 * is scoped to the viewer's own concern: that a distinguishing fingerprint
 * actually produces a distinguishing `buildGeometryCacheKey`.
 */
function oldWeakFingerprint(buffer: ArrayBuffer): string {
  const CHUNK_SIZE = 4096;
  const view = new Uint8Array(buffer);
  const len = view.length;
  let hash = 2166136261;
  const firstEnd = Math.min(CHUNK_SIZE, len);
  for (let i = 0; i < firstEnd; i++) {
    hash ^= view[i];
    hash = Math.imul(hash, 16777619);
  }
  if (len > CHUNK_SIZE) {
    const lastStart = Math.max(CHUNK_SIZE, len - CHUNK_SIZE);
    for (let i = lastStart; i < len; i++) {
      hash ^= view[i];
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(16);
}

function fill(len: number, seed: number): ArrayBuffer {
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    view[i] = x & 0xff;
  }
  return buf;
}

describe('buildGeometryCacheKey', () => {
  it('folds size, fingerprint and format version into the key', () => {
    const key = buildGeometryCacheKey(1024, 'abc123', false, 7);
    assert.strictEqual(key, 'ifc-1024-abc123-v7-g5');
  });

  it('omits the merge-layers discriminator when merging is off', () => {
    const key = buildGeometryCacheKey(2048, 'deadbeef', false, 5);
    assert.ok(!key.includes('-ml'), `expected no merge suffix, got ${key}`);
  });

  it('appends a merge-layers discriminator when merging is on', () => {
    const key = buildGeometryCacheKey(2048, 'deadbeef', true, 5);
    assert.strictEqual(key, 'ifc-2048-deadbeef-v5-g5-ml');
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

  it('omits the skip-small-cuts discriminator by default', () => {
    const unset = buildGeometryCacheKey(2048, 'deadbeef', false, 5);
    const off = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    assert.strictEqual(unset, 'ifc-2048-deadbeef-v5-g5');
    assert.strictEqual(off, 'ifc-2048-deadbeef-v5-g5');
  });

  it('appends a skip-small-cuts discriminator when on (#1286: skipped display cache must not collide with full-cut)', () => {
    const skip = buildGeometryCacheKey(2048, 'deadbeef', false, 5, true);
    const full = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    assert.strictEqual(skip, 'ifc-2048-deadbeef-v5-g5-sc');
    assert.notStrictEqual(skip, full);
  });

  it('composes the merge-layers and skip-small-cuts discriminators and stays filename-safe', () => {
    const key = buildGeometryCacheKey(4096, 'feed', true, 5, true);
    assert.strictEqual(key, 'ifc-4096-feed-v5-g5-ml-sc');
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });

  it('omits the tessellation-tier discriminator at the medium default', () => {
    const unset = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false);
    const medium = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'medium');
    assert.strictEqual(unset, 'ifc-2048-deadbeef-v5-g5');
    assert.strictEqual(medium, 'ifc-2048-deadbeef-v5-g5');
  });

  it('appends a tessellation-tier discriminator for a non-default tier (auto-low must not collide with medium)', () => {
    const low = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'low');
    const medium = buildGeometryCacheKey(2048, 'deadbeef', false, 5, false, 'medium');
    assert.strictEqual(low, 'ifc-2048-deadbeef-v5-g5-tlow');
    assert.notStrictEqual(low, medium);
  });

  it('#4056 invalidates pre-correction geometry for every persisted option combination', () => {
    for (const mergeLayers of [false, true]) {
      for (const skipSmallCuts of [false, true]) {
        for (const tier of ['medium', 'low', 'lowest']) {
          // The old persisted namespace is a compatibility witness, not a
          // second implementation of the new revision-bearing key.
          const legacy = `ifc-4096-feed-v18${mergeLayers ? '-ml' : ''}${skipSmallCuts ? '-sc' : ''}${tier === 'medium' ? '' : `-t${tier}`}`;
          const current = buildGeometryCacheKey(4096, 'feed', mergeLayers, 18, skipSmallCuts, tier);
          assert.notStrictEqual(current, legacy);
          assert.match(current, /^[A-Za-z0-9_-]+$/);
        }
      }
    }
  });

  it('produces distinct keys per tier so different densities cache separately', () => {
    const low = buildGeometryCacheKey(4096, 'feed', false, 5, false, 'low');
    const lowest = buildGeometryCacheKey(4096, 'feed', false, 5, false, 'lowest');
    assert.notStrictEqual(low, lowest);
  });

  it('composes all discriminators and stays filename-safe', () => {
    const key = buildGeometryCacheKey(4096, 'feed', true, 5, true, 'lowest');
    assert.strictEqual(key, 'ifc-4096-feed-v5-g5-ml-sc-tlowest');
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  });
});

describe('buildGeometryCacheKey + computeSourceFingerprint (integration)', () => {
  it('a HEAD change the old weak key missed produces a distinct geometry cache key under the strengthened fingerprint', () => {
    // A 1MB file; flip one byte at 32KB — outside the old first/last-4KB
    // windows (so the old key collides) but inside the new 64KB head window.
    const a = fill(1_048_576, 42);
    const b = a.slice(0);
    new Uint8Array(b)[32 * 1024] ^= 0xff;

    // Sanity: the two files DO collide on the old weak key.
    assert.strictEqual(oldWeakFingerprint(a), oldWeakFingerprint(b));
    assert.strictEqual(
      buildGeometryCacheKey(a.byteLength, oldWeakFingerprint(a), false),
      buildGeometryCacheKey(b.byteLength, oldWeakFingerprint(b), false),
    );

    // The strengthened fingerprint distinguishes them -> different cache key
    // -> the second file is NOT served the first file's cached geometry.
    const fpA = computeSourceFingerprint(a);
    const fpB = computeSourceFingerprint(b);
    assert.notStrictEqual(fpA.hex, fpB.hex);
    assert.notStrictEqual(
      buildGeometryCacheKey(a.byteLength, fpA.hex, false),
      buildGeometryCacheKey(b.byteLength, fpB.hex, false),
    );
  });
});
