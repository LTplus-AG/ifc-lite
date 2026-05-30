/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { isExcluded, makeExclusionSet, pairKey } from './exclude.js';

describe('exclusions', () => {
  it('pairKey is order-independent', () => {
    expect(pairKey('a', 'b')).toBe(pairKey('b', 'a'));
    expect(pairKey('wall-1', 'door-2')).toBe(pairKey('door-2', 'wall-1'));
  });

  it('isExcluded reflects membership regardless of order', () => {
    const set = makeExclusionSet([
      ['wall-1', 'door-2'],
      ['slab-3', 'beam-4'],
    ]);
    expect(isExcluded(set, 'wall-1', 'door-2')).toBe(true);
    expect(isExcluded(set, 'door-2', 'wall-1')).toBe(true);
    expect(isExcluded(set, 'wall-1', 'beam-4')).toBe(false);
  });

  it('empty set excludes nothing', () => {
    const set = makeExclusionSet();
    expect(isExcluded(set, 'a', 'b')).toBe(false);
  });
});
