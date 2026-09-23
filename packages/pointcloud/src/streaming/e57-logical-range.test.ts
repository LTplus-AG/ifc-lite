/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { BlobByteSource } from './blob-source.js';
import { readE57LogicalRange } from './e57-logical-range.js';

/** Two 16-byte pages: 12 payload bytes (0..11, 12..23) plus a 4-byte CRC each. */
function pagedSource(): BlobByteSource {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 12; i++) {
    bytes[i] = i;
    bytes[16 + i] = 12 + i;
  }
  return new BlobByteSource(new Blob([bytes]));
}

describe('readE57LogicalRange (#5203)', () => {
  it('reads a range spanning a page boundary without the CRC bytes', async () => {
    const got = await readE57LogicalRange(pagedSource(), 10, 4, 16, undefined, { strict: true });
    expect([...got]).toEqual([10, 11, 12, 13]);
  });

  it('strict: a range past the end of the blob throws with expected and actual counts', async () => {
    await expect(readE57LogicalRange(pagedSource(), 20, 10, 16, undefined, { strict: true }))
      .rejects.toThrow('expects 10 bytes at logical offset 20, got 4');
  });

  it('rejects a non-finite offset or length instead of returning an empty "success"', async () => {
    for (const [start, len] of [[0, Number.NaN], [Number.NaN, 4], [0, Infinity]]) {
      await expect(readE57LogicalRange(pagedSource(), start, len, 16, undefined, { strict: true }))
        .rejects.toThrow('invalid logical range');
      await expect(readE57LogicalRange(pagedSource(), start, len, 16))
        .rejects.toThrow('invalid logical range');
    }
  });
});
