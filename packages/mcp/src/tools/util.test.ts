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
