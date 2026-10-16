/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { CompactEntityIndexBuilder, buildCompactEntityIndex, buildCompactEntityIndexAsync } from './compact-entity-index.js';
import type { EntityRef } from './types.js';

const ref = (expressId: number, byteOffset: number): EntityRef => ({
  expressId,
  type: 'IFCWALL',
  byteOffset,
  byteLength: 10,
  lineNumber: 0,
});

/** #7675: core, the server and the exporter keep the LAST record of a
 * duplicated express id; the index must resolve to it too. */
describe('CompactEntityIndex duplicate ids', () => {
  const adjacent = [ref(1, 0), ref(2, 100), ref(2, 200), ref(2, 300), ref(3, 400)];
  // #2 is written at 100, then #9, then again at 500 and 600: sorting puts the
  // copies together, in file order.
  const split = [ref(1, 0), ref(2, 100), ref(9, 200), ref(5, 300), ref(2, 500), ref(7, 550), ref(2, 600)];

  for (const [name, build] of [
    ['sync', async (r: EntityRef[]) => buildCompactEntityIndex(r)],
    ['async', (r: EntityRef[]) => buildCompactEntityIndexAsync(r)],
  ] as const) {
    it(`${name}: adjacent duplicates resolve to the last record`, async () => {
      const index = await build(adjacent);
      expect(index.get(2)?.byteOffset).toBe(300);
      expect(index.getByteRange(2)?.byteOffset).toBe(300);
      expect(index.get(1)?.byteOffset).toBe(0);
      expect(index.get(3)?.byteOffset).toBe(400);
    });

    it(`${name}: duplicates split across the file resolve to the last record in file order`, async () => {
      const index = await build(split);
      expect(index.get(2)?.byteOffset).toBe(600);
      expect(index.getByteRange(2)?.byteOffset).toBe(600);
      expect(index.has(2)).toBe(true);
      expect(index.get(9)?.byteOffset).toBe(200);
    });
  }

  it('the builder keeps file order for unsorted duplicates', () => {
    const builder = new CompactEntityIndexBuilder(2);
    for (const r of split) builder.add(r.expressId, r.type, r.byteOffset, r.byteLength);
    const index = builder.build();
    expect(index.get(2)?.byteOffset).toBe(600);
    expect(index.getByteRange(2)?.byteOffset).toBe(600);
  });
});
