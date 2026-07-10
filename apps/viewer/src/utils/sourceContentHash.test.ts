/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFullSourceHash } from './sourceContentHash.js';
import { computeSourceFingerprint } from '../hooks/sourceFingerprint.js';
import { decideMeshOnlyCacheHit } from '../hooks/cacheTier.js';

/** Deterministic pseudo-random fill (xorshift32) so both files vary "for real". */
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

describe('computeFullSourceHash (SHA-256, off-thread validation hash)', () => {
  it('matches the known SHA-256 of the empty input', async () => {
    const hash = await computeFullSourceHash(new Uint8Array(0));
    assert.equal(hash, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is deterministic and lowercase hex', async () => {
    const buf = fill(50_000, 9);
    const a = await computeFullSourceHash(buf);
    const b = await computeFullSourceHash(buf.slice(0));
    assert.equal(a, b);
    assert.match(a!, /^[0-9a-f]{64}$/);
  });

  it('accepts an ArrayBuffer and an equivalent Uint8Array view identically', async () => {
    const buf = fill(20_000, 11);
    assert.equal(
      await computeFullSourceHash(buf),
      await computeFullSourceHash(new Uint8Array(buf)),
    );
  });

  it('changes for ANY single-byte edit, including one in a fingerprint GAP', async () => {
    const a = fill(4_000_000, 202);
    const b = a.slice(0);
    new Uint8Array(b)[700_000] ^= 0xff; // a sampler-gap byte
    assert.notEqual(await computeFullSourceHash(a), await computeFullSourceHash(b));
  });
});

// The end-to-end safety proof the coordinator asked for: a byte-length-preserving
// edit in a sampler GAP that the FINGERPRINT alone false-hits is nonetheless
// caught — by the mtime guard, and (if mtime is preserved) by the full-file hash
// background revalidation. Neither guard depends on the fingerprint.
describe('source-decoupled gap-edit safety (fingerprint false-hit is still caught)', () => {
  it('mtime guard catches a gap edit the fingerprint misses', () => {
    const a = fill(4_000_000, 303);
    const b = a.slice(0);
    new Uint8Array(b)[700_000] ^= 0xff;

    // The fingerprint false-hits (same key) …
    assert.equal(computeSourceFingerprint(a).hex, computeSourceFingerprint(b).hex);
    // … but any real on-disk edit bumps mtime → the hit is a safe MISS.
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 1001, hasFullHash: true }),
      'miss',
    );
  });

  it('full-file hash catches a gap edit even with mtime PRESERVED (deliberate attack)', async () => {
    const a = fill(4_000_000, 404);
    const b = a.slice(0);
    new Uint8Array(b)[700_000] ^= 0xff;

    // Fingerprint false-hits AND the attacker preserved the mtime → mtime says
    // "serve". The background full-hash revalidation is the last line of defense:
    assert.equal(computeSourceFingerprint(a).hex, computeSourceFingerprint(b).hex);
    assert.equal(
      decideMeshOnlyCacheHit({ storedMtime: 1000, freshMtime: 1000, hasFullHash: true }),
      'serve',
    );
    const storedHash = await computeFullSourceHash(a); // written at cache time
    const freshHash = await computeFullSourceHash(b);   // recomputed on the fresh buffer
    assert.notEqual(freshHash, storedHash, 'full-hash mismatch → purge + reload');
  });
});
