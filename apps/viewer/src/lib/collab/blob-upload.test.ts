/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `uploadCountOption` and `putBlobWithRetry` were, until now, only exercised
 * indirectly through `geometry-sync.test.ts`'s `seedGeometryToRoom` cases
 * (which pin `concurrency`/`maxFailures` against a NaN override). `retries`
 * itself, the floor/negative/fractional edges of the guard, and
 * `putBlobWithRetry`'s own attempt-count and error-identity contract were
 * never pinned directly. `boundedRetryDelayMs` already has its own direct
 * coverage in `geometry-sync.test.ts`'s "retry backoff bounds" — not
 * duplicated here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { BlobStore, BlobMeta } from '@ifc-lite/collab';
import { putBlobWithRetry, uploadCountOption } from './blob-upload.js';

describe('uploadCountOption', () => {
  it('passes a valid non-negative integer through untouched', () => {
    assert.equal(uploadCountOption(5, 99), 5);
    assert.equal(uploadCountOption(0, 99), 0, 'zero is a legitimate override (e.g. retries: 0)');
  });

  it('floors a fractional value rather than rejecting it', () => {
    assert.equal(uploadCountOption(2.9, 99), 2);
  });

  it('falls back on NaN — the guard this function exists for', () => {
    // `failures >= NaN` is false forever: a NaN override must fall back to the
    // default rather than silently disabling the ceiling it configures.
    assert.equal(uploadCountOption(Number.NaN, 10), 10);
  });

  it('falls back on a negative value', () => {
    assert.equal(uploadCountOption(-5, 10), 10);
  });

  it('falls back on +/- Infinity', () => {
    assert.equal(uploadCountOption(Number.POSITIVE_INFINITY, 10), 10);
    assert.equal(uploadCountOption(Number.NEGATIVE_INFINITY, 10), 10);
  });

  it('falls back on undefined', () => {
    assert.equal(uploadCountOption(undefined, 10), 10);
  });
});

/** A `BlobStore` whose `put()` fails a fixed number of times, then succeeds. */
class CountingBlobStore implements BlobStore {
  attempts = 0;
  constructor(private readonly failFirst: number) {}
  async put(_bytes: Uint8Array, _contentType?: string): Promise<BlobMeta> {
    this.attempts++;
    if (this.attempts <= this.failFirst) throw new Error(`synthetic failure #${this.attempts}`);
    return { hash: `hash-${this.attempts}`, byteLength: 0, contentType: 'application/octet-stream' };
  }
  get(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }
  has(): Promise<boolean> {
    return Promise.resolve(false);
  }
  delete(): Promise<boolean> {
    return Promise.resolve(false);
  }
  list(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

describe('putBlobWithRetry', () => {
  it('returns on the first successful attempt without retrying', async () => {
    const store = new CountingBlobStore(0);
    const result = await putBlobWithRetry(store, new Uint8Array([1]), 2, [0, 0]);
    assert.equal(store.attempts, 1);
    assert.equal(result.hash, 'hash-1');
  });

  it('retries exactly up to `retries` and returns once it succeeds', async () => {
    const store = new CountingBlobStore(2); // fails attempts 1 and 2, succeeds on 3
    const result = await putBlobWithRetry(store, new Uint8Array([1]), 2, [0, 0]);
    assert.equal(store.attempts, 3, 'the initial attempt plus exactly 2 retries');
    assert.equal(result.hash, 'hash-3');
  });

  it('makes exactly retries+1 attempts total, never one more, when every attempt fails', async () => {
    const store = new CountingBlobStore(Number.POSITIVE_INFINITY);
    await assert.rejects(() => putBlobWithRetry(store, new Uint8Array([1]), 2, [0, 0]));
    assert.equal(store.attempts, 3, 'retries: 2 means 3 total attempts, not 2');
  });

  it('throws the actual last error, not a synthesized one', async () => {
    const store = new CountingBlobStore(Number.POSITIVE_INFINITY);
    await assert.rejects(
      () => putBlobWithRetry(store, new Uint8Array([1]), 1, [0]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, 'synthetic failure #2', 'the LAST attempt error, not the first');
        return true;
      },
    );
  });

  it('with zero retries, makes exactly one attempt and surfaces its error', async () => {
    const store = new CountingBlobStore(Number.POSITIVE_INFINITY);
    await assert.rejects(() => putBlobWithRetry(store, new Uint8Array([1]), 0, []));
    assert.equal(store.attempts, 1, 'retries: 0 must not silently retry anyway');
  });
});
