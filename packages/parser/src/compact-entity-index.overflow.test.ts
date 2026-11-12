/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { CompactEntityIndexBuilder, buildCompactEntityIndex, buildCompactEntityIndexAsync } from './compact-entity-index.js';
it('rejects byte spans that would wrap uint32 (huge-file report)', async () => {
  const builder = new CompactEntityIndexBuilder(1);
  for (const byteOffset of [2 ** 32, 2 ** 32 + 1, -1, 1.5, NaN, Infinity, -Infinity]) {
    const ref = { expressId: 1, type: 'IFCWALL', byteOffset, byteLength: 10, lineNumber: 1 };
    expect(() => builder.add(1, ref.type, byteOffset, 10)).toThrow(RangeError);
    expect(() => buildCompactEntityIndex([ref])).toThrow(RangeError);
    await expect(buildCompactEntityIndexAsync([ref])).rejects.toThrow(RangeError);
  }
  expect(builder.build().size).toBe(0);
  builder.add(1, 'IFCWALL', 2 ** 32 - 1, 1);
  expect(builder.build().get(1)?.byteOffset).toBe(2 ** 32 - 1);
});

// PR #9617: the length column has the same numeric contract as offsets.
it('rejects invalid lengths in every construction path', async () => {
  const builder = new CompactEntityIndexBuilder(1);
  for (const byteLength of [2 ** 32, NaN, Infinity, -Infinity, -1, 0.5]) {
    const ref = { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength, lineNumber: 1 };
    expect(() => builder.add(1, ref.type, 0, byteLength)).toThrow(RangeError);
    expect(() => buildCompactEntityIndex([ref])).toThrow(RangeError);
    await expect(buildCompactEntityIndexAsync([ref])).rejects.toThrow(RangeError);
  }
  expect(builder.build().size).toBe(0);
  builder.add(1, 'IFCWALL', 0, 0);
  expect(builder.build().get(1)?.byteLength).toBe(0);
});
