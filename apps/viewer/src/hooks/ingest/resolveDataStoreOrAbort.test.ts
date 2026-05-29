/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { resolveDataStoreOrAbort } from './resolveDataStoreOrAbort.js';

const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

describe('resolveDataStoreOrAbort', () => {
  it('returns the parse result when not aborted', async () => {
    const store = { id: 'store' };
    const result = await resolveDataStoreOrAbort(Promise.resolve(store), { aborted: false });
    assert.equal(result, store);
  });

  it('throws AbortError and terminates without awaiting a blocked parse', async () => {
    let terminated = false;
    // A promise that never settles — mirrors a worker parse blocked on
    // waitForEntityIndex after the geometry loop was cancelled. The previous
    // code awaited this directly and hung forever.
    const neverSettles = new Promise<unknown>(() => {});

    await assert.rejects(
      resolveDataStoreOrAbort(neverSettles, {
        aborted: true,
        terminate: () => {
          terminated = true;
        },
      }),
      isAbortError,
    );

    assert.equal(terminated, true, 'the worker parser should be terminated on abort');
  });

  it('swallows the abandoned parse rejection on abort', async () => {
    // A parse that rejects after we bail must not surface as an unhandled
    // rejection (this test would fail the process if the .catch guard were
    // removed from resolveDataStoreOrAbort).
    const rejecting = Promise.reject(new Error('worker died after abort'));

    await assert.rejects(
      resolveDataStoreOrAbort(rejecting, { aborted: true }),
      isAbortError,
    );

    // Give the swallowed rejection a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('works without a terminate callback', async () => {
    await assert.rejects(
      resolveDataStoreOrAbort(new Promise<unknown>(() => {}), { aborted: true }),
      isAbortError,
    );
  });
});
