/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { watchedGeometryStream } from './watchedGeometryStream.js';

/** Build a controllable async source that records when return() is called. */
function makeSource<T>(values: T[]): { source: AsyncIterable<T>; returned: () => boolean } {
  let didReturn = false;
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => (i < values.length
          ? { done: false, value: values[i++] }
          : { done: true, value: undefined as unknown as T }),
        return: async () => {
          didReturn = true;
          return { done: true, value: undefined as unknown as T };
        },
      };
    },
  };
  return { source, returned: () => didReturn };
}

const baseOpts = {
  fileName: 'test.ifc',
  fileSizeMB: 1,
  getBatchCount: () => 0,
  getLastTotalMeshes: () => 0,
  cleanupMs: 50,
};

describe('watchedGeometryStream', () => {
  it('re-yields every event in order then completes', async () => {
    const { source } = makeSource([1, 2, 3]);
    const seen: number[] = [];
    for await (const v of watchedGeometryStream(source, baseOpts)) seen.push(v);
    assert.deepStrictEqual(seen, [1, 2, 3]);
  });

  it('stops early when shouldAbort() turns true', async () => {
    const { source } = makeSource([1, 2, 3, 4]);
    const seen: number[] = [];
    let calls = 0;
    for await (const v of watchedGeometryStream(source, {
      ...baseOpts,
      // Abort after the second event has been consumed.
      shouldAbort: () => (++calls > 2),
    })) {
      seen.push(v);
    }
    assert.deepStrictEqual(seen, [1, 2]);
  });

  it('tears down the underlying iterator on normal completion', async () => {
    const { source, returned } = makeSource([1]);
    let count = 0;
    for await (const v of watchedGeometryStream(source, baseOpts)) count += v;
    assert.strictEqual(count, 1);
    assert.strictEqual(returned(), true);
  });

  it('tears down the underlying iterator when the consumer breaks early', async () => {
    const { source, returned } = makeSource([1, 2, 3]);
    const seen: number[] = [];
    for await (const v of watchedGeometryStream(source, baseOpts)) {
      seen.push(v);
      break;
    }
    assert.deepStrictEqual(seen, [1]);
    assert.strictEqual(returned(), true);
  });
});
