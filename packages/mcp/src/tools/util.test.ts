/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { okResult, paginate, fmtCount } from './util.js';

describe('tool utilities', () => {
  it('paginates with truncation flag', () => {
    const out = paginate([1, 2, 3, 4, 5], 2, 1);
    expect(out.items).toEqual([2, 3]);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(5);
  });

  it('does not flag truncation at the end', () => {
    const out = paginate([1, 2, 3], 5, 0);
    expect(out.items).toEqual([1, 2, 3]);
    expect(out.truncated).toBe(false);
  });

  it('does not flag truncation on a page that lands exactly on the end', () => {
    // The boundary the two tests above straddle without touching: the previous
    // pair used offset+limit=3 against total 5 (truncated) and offset+limit=5
    // against total 3 (not truncated), so `<` could become `<=` untouched. An
    // agent paginating a result set whose size is a multiple of its page size
    // would then be told there is more and ask for an empty next page forever.
    const exact = paginate([1, 2, 3, 4], 2, 2);
    expect(exact.items).toEqual([3, 4]);
    expect(exact.truncated).toBe(false);
    expect(exact.total).toBe(4);

    // And one item short of the end still is truncated, so the assertion above
    // is about the boundary and not about truncation never being reported.
    const short = paginate([1, 2, 3, 4, 5], 2, 2);
    expect(short.items).toEqual([3, 4]);
    expect(short.truncated).toBe(true);
  });

  it('defaults offset to 0', () => {
    expect(paginate([1, 2, 3], 2).items).toEqual([1, 2]);
    expect(paginate([1, 2, 3], 2).truncated).toBe(true);
  });

  it('formats count', () => {
    expect(fmtCount(1, 'door')).toBe('1 door');
    expect(fmtCount(3, 'door')).toBe('3 doors');
    expect(fmtCount(2, 'wall', 'walls')).toBe('2 walls');
    expect(fmtCount(2500, 'wall')).toBe('2,500 walls');
  });

  it('okResult builds structured shape', () => {
    const r = okResult('ok', { count: 1 });
    expect(r.content[0]).toEqual({ type: 'text', text: 'ok' });
    expect(r.structuredContent).toEqual({ count: 1 });
  });
});
