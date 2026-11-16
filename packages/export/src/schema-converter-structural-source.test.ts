/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { listItems } from './schema-converter-structural-axes.js';
import { slotRef, slotUnset } from './schema-converter-structural-source.js';

// #9668 review (PR #10551): optional slots reach these readers as undefined
// when a source record is unreadable or shorter than expected.
describe('structural slot readers #9668', () => {
  it('reads a missing slot as no reference', () => {
    expect(slotRef(undefined)).toBeNull();
    expect(slotRef('')).toBeNull();
  });

  it('reads a missing slot as set, not unset', () => {
    expect(slotUnset(undefined)).toBe(false);
  });

  it('reads references and $ beside STEP comments, and rejects trailing text (#10248)', () => {
    expect(slotRef('#20')).toBe(20);
    expect(slotRef(' /* c */ #20 /* d */')).toBe(20);
    expect(slotRef('#20 x')).toBeNull();
    expect(slotUnset(' $ /* none */')).toBe(true);
    expect(slotUnset('$ x')).toBe(false);
  });

  it('reads a missing list as no list', () => {
    expect(listItems(undefined)).toBeNull();
  });
});
