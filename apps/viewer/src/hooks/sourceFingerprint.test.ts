/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSourceFingerprint } from './sourceFingerprint.js';
import { buildGeometryCacheKey } from './geometryCacheKey.js';

/**
 * Reference implementation of the OLD, weak fingerprint this PR replaces: FNV-1a
 * over the first 4KB + last 4KB, 32 bits, ignoring the entire interior of the
 * file. Kept here ONLY to PROVE (below) that a file pair which collides on the
 * old key is distinguished by the new spread-sampled fingerprint.
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

/** Deterministic pseudo-random fill so both files have "real" varied content. */
function fill(len: number, seed: number): ArrayBuffer {
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) {
    // xorshift32
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    view[i] = x & 0xff;
  }
  return buf;
}

describe('computeSourceFingerprint', () => {
  it('is deterministic (same bytes → same hash) and filename-safe hex', () => {
    const buf = fill(1_000_000, 1);
    const a = computeSourceFingerprint(buf);
    const b = computeSourceFingerprint(buf.slice(0));
    assert.equal(a.hex, b.hex);
    assert.equal(a.hash, b.hash);
    assert.equal(a.hex, a.hash.toString(16));
    assert.match(a.hex, /^[0-9a-f]+$/);
  });

  it('changes when the exact byte length changes (length folded into the hash)', () => {
    const a = computeSourceFingerprint(fill(1_000_000, 7));
    const b = computeSourceFingerprint(fill(1_000_001, 7));
    assert.notEqual(a.hex, b.hex);
  });

  it('detects a change in the file HEAD (first 64KB) that the old key missed', () => {
    // A 1MB file; flip one byte at 32KB — outside the old first/last-4KB windows
    // (so the old key collides) but inside the new 64KB head window.
    const a = fill(1_048_576, 42);
    const b = a.slice(0);
    new Uint8Array(b)[32 * 1024] ^= 0xff;

    // The old weak key collides: same length + same first/last 4KB.
    assert.equal(oldWeakFingerprint(a), oldWeakFingerprint(b));
    assert.equal(
      buildGeometryCacheKey(a.byteLength, oldWeakFingerprint(a), false),
      buildGeometryCacheKey(b.byteLength, oldWeakFingerprint(b), false),
      'sanity: the two files DO collide on the old weak key',
    );

    // The strengthened fingerprint distinguishes them → different cache key →
    // the second file is NOT served the first file's cached geometry.
    const fpA = computeSourceFingerprint(a);
    const fpB = computeSourceFingerprint(b);
    assert.notEqual(fpA.hex, fpB.hex);
    assert.notEqual(
      buildGeometryCacheKey(a.byteLength, fpA.hex, false),
      buildGeometryCacheKey(b.byteLength, fpB.hex, false),
    );
  });

  it('detects a genuinely different INTERIOR (same header/footer/length) the old key missed', () => {
    // Model two files that share the first/last 4KB and exact length (so the old
    // weak key collides) but differ throughout the interior — exactly how two
    // real, independently-authored IFC models relate once you look past the STEP
    // header. The interior differs across the whole body, so it intersects the
    // new spread's interior sample windows and is caught.
    const a = fill(1_048_576, 99);
    const b = a.slice(0);
    const vb = new Uint8Array(b);
    for (let i = 8 * 1024; i < b.byteLength - 8 * 1024; i += 617 /* prime stride */) {
      vb[i] ^= 0xff;
    }

    assert.equal(oldWeakFingerprint(a), oldWeakFingerprint(b), 'old key collides (first/last 4KB unchanged)');
    assert.notEqual(
      computeSourceFingerprint(a).hex,
      computeSourceFingerprint(b).hex,
      'new fingerprint catches the differing interior',
    );
  });

  it('samples inside a fixed interior window (a change there is always caught)', () => {
    // A byte change landing squarely on an interior sample window is caught even
    // when it is nowhere near the head/tail — proving the interior windows carry
    // real discriminating power, not just the head/tail.
    const len = 4_000_000;
    const a = fill(len, 71);
    // Center of the 4th of 8 interior windows: floor(len * 4 / 9).
    const sampled = Math.floor((len * 4) / 9);
    const b = a.slice(0);
    new Uint8Array(b)[sampled] ^= 0xff;
    assert.notEqual(computeSourceFingerprint(a).hex, computeSourceFingerprint(b).hex);
  });

  it('detects a change in the file TAIL (last 64KB)', () => {
    const a = fill(1_048_576, 123);
    const b = a.slice(0);
    new Uint8Array(b)[1_048_576 - 100] ^= 0xff;
    assert.notEqual(computeSourceFingerprint(a).hex, computeSourceFingerprint(b).hex);
  });

  it('handles tiny buffers (smaller than one window) without error', () => {
    const a = computeSourceFingerprint(fill(100, 3));
    const b = computeSourceFingerprint(fill(100, 4));
    assert.match(a.hex, /^[0-9a-f]+$/);
    assert.notEqual(a.hex, b.hex);
  });

  it('accepts a Uint8Array view as well as an ArrayBuffer', () => {
    const buf = fill(200_000, 55);
    assert.equal(
      computeSourceFingerprint(buf).hex,
      computeSourceFingerprint(new Uint8Array(buf)).hex,
    );
  });

  it('FALSE-HITS a byte-length-preserving edit in a sampler GAP (documents the O(1) blind spot)', () => {
    // The whole point of the O(1) sampler is that it does NOT read the bytes
    // between its windows. A same-length in-place edit there (a GUID patch, a
    // scripted same-width coordinate edit) is INVISIBLE to the fingerprint, so it
    // keys the same cache entry. This is why the fingerprint is only the LOOKUP
    // key and the mesh-only tier validates a hit by mtime + a full-file hash.
    const len = 4_000_000;
    const a = fill(len, 202);
    const b = a.slice(0);
    // 700_000 is between interior window 1 (~444_444) and window 2 (~888_888),
    // outside the 64KB head/tail — a genuine sampler gap.
    const gapOffset = 700_000;
    new Uint8Array(b)[gapOffset] ^= 0xff;

    assert.equal(a.byteLength, b.byteLength, 'edit preserves the byte length');
    assert.equal(
      computeSourceFingerprint(a).hex,
      computeSourceFingerprint(b).hex,
      'a gap edit is invisible to the fingerprint (the documented limitation)',
    );
  });
});
