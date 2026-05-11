/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PALETTE, colorForUser, fnv1a } from '../src/awareness/color.js';

describe('colorForUser', () => {
  it('is deterministic for the same id', () => {
    expect(colorForUser('louis')).toBe(colorForUser('louis'));
    expect(colorForUser('anna')).toBe(colorForUser('anna'));
  });

  it('returns a color from the default palette', () => {
    expect(DEFAULT_USER_PALETTE).toContain(colorForUser('louis'));
  });

  it('honors a custom palette', () => {
    const palette = ['#000000', '#ffffff'];
    const c = colorForUser('id', palette);
    expect(palette).toContain(c);
  });

  it('throws on an empty palette', () => {
    expect(() => colorForUser('id', [])).toThrow();
  });

  it('produces different colors for sufficiently different ids in expectation', () => {
    // Not a strict guarantee, but the FNV distribution should not collapse
    // common ids onto a single bucket.
    const sample = new Set<string>();
    for (const id of ['louis', 'anna', 'mark', 'jane', 'sven', 'eve', 'hans']) {
      sample.add(colorForUser(id));
    }
    expect(sample.size).toBeGreaterThanOrEqual(3);
  });

  it('fnv1a returns an unsigned 32-bit integer', () => {
    const h = fnv1a('test');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});
