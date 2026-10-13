/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7537: the exported entity filters keep one candidate per entity and still
 * return any number of ids, as they did before. A `Set` has an engine limit
 * (V8 throws on the insert past 2^24 entries). A run past 2^24 real ids takes
 * seconds and over a gigabyte, so these tests stand a small limit in for V8's;
 * `docs/architecture/evidence/7537-entity-list-distinct-ids` has the full-size
 * run.
 */

import { describe, it, expect, vi } from 'vitest';
import { distinctIds } from './distinct-ids.js';
import { filterByEntityFacet } from './entity-facet.js';
import { filterByFacet } from './index.js';
import { createMockAccessor } from './test-helpers.js';
import type { IDSEntityFacet, IFCDataAccessor } from '../types.js';

/** Run `body` while every `Set` refuses a new entry past `limit`, as V8 does past 2^24. */
function withSetLimit<T>(limit: number, body: () => T): T {
  const add = Set.prototype.add;
  const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
    if (!this.has(value) && this.size >= limit) throw new RangeError('Set maximum size exceeded');
    return add.call(this, value);
  });
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

const listed = (...values: string[]): IDSEntityFacet => ({ type: 'entity', name: { type: 'enumeration', values } });

/** Five walls (1 to 5) and three slabs (6 to 8). */
const model = (): IFCDataAccessor =>
  createMockAccessor([
    ...[1, 2, 3, 4, 5].map((expressId) => ({ expressId, type: 'IfcWall' })),
    ...[6, 7, 8].map((expressId) => ({ expressId, type: 'IfcSlab' })),
  ]);

describe('the exported entity filters past the Set limit (#7537)', () => {
  it('filterByEntityFacet returns every distinct id where one Set would be refused', () => {
    // Before, with one Set: `RangeError: Set maximum size exceeded`.
    const ids = withSetLimit(3, () => filterByEntityFacet(listed('IFCWALL', 'IFCSLAB', 'IFCWALL'), model()));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('filterByFacet does the same', () => {
    const ids = withSetLimit(3, () => filterByFacet(listed('IFCSLAB', 'IFCWALL', 'IFCSLAB'), model()));
    expect(ids).toEqual([6, 7, 8, 1, 2, 3, 4, 5]);
  });

  it('the stand-in limit is real: one Set past it throws', () => {
    expect(() => withSetLimit(3, () => new Set([1, 2, 3, 4]))).toThrow('Set maximum size exceeded');
  });
});

describe('distinctIds (#7537)', () => {
  it('returns each id once, in first-seen order, across lists', () => {
    expect(distinctIds([[1, 2, 3], [3, 4, 1], [5]])).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps an id taken in an earlier Set out after that Set was refused more', () => {
    const ids = withSetLimit(2, () => distinctIds([[1, 2, 3], [2, 1, 4, 3], [4, 5, 1]]));
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts a new Set only for the Set limit, and lets any other error through', () => {
    const add = Set.prototype.add;
    let thrown = false;
    const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value: unknown) {
      if (value === 3 && !thrown) {
        thrown = true;
        throw new TypeError('not a Set limit');
      }
      return add.call(this, value);
    });
    try {
      expect(() => distinctIds([[1, 2, 3, 4]])).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads each list before the next is asked for, as the plain loop did', () => {
    // An accessor may refill one array on every call; the type allows it.
    const scratch: number[] = [];
    const accessor = {
      ...model(),
      getEntitiesByType(type: string): number[] {
        scratch.length = 0;
        scratch.push(...(type.toUpperCase() === 'IFCWALL' ? [1, 2, 3] : [3, 6]));
        return scratch;
      },
    };
    expect(filterByEntityFacet(listed('IFCWALL', 'IFCSLAB'), accessor)).toEqual([1, 2, 3, 6]);
  });
});
