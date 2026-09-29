/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `downloadPercent` turns a provider's `onProgress(received, total)` into the
 * ring's value (#6375). Provider numbers are untrusted: anything that is not
 * a finite, non-negative count must read as "size unknown" (a spinner),
 * never as a NaN percentage the ring and its text would disagree on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { downloadPercent } from './downloadProgress.js';

describe('downloadPercent', () => {
  it('is received over total, capped at 100', () => {
    assert.equal(downloadPercent({ phase: 'downloading', received: 25, total: 100 }), 25);
    assert.equal(downloadPercent({ phase: 'downloading', received: 150, total: 100 }), 100);
    assert.equal(downloadPercent({ phase: 'downloading', received: 0, total: 0 }), 100);
  });

  it('is unknown without a usable total or count', () => {
    for (const [received, total] of [
      [10, undefined],
      [10, Number.NaN],
      [10, Number.POSITIVE_INFINITY],
      [10, -1],
      [Number.NaN, 100],
      [-5, 100],
    ] as const) {
      assert.equal(downloadPercent({ phase: 'downloading', received, total }), undefined, `(${received}, ${total})`);
    }
  });

  it('is unknown for a queued or failed file', () => {
    assert.equal(downloadPercent({ phase: 'queued' }), undefined);
    assert.equal(downloadPercent({ phase: 'failed' }), undefined);
  });
});
