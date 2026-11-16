/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { slotRef, slotUnset } from './schema-converter-structural-source.js';

// #9668 review (PR #10551): optional slots reach these readers as undefined
// when a source record is unreadable or shorter than expected.
describe('structural slot readers #9668', () => {
  it('reads a missing slot as no reference instead of throwing', () => {
    expect(slotRef(undefined)).toBeNull();
    expect(slotRef('')).toBeNull();
  });

  it('reads references beside STEP comments (#10248)', () => {
    expect(slotRef('#20')).toBe(20);
    expect(slotRef(' /* c */ #20 /* d */')).toBe(20);
    expect(slotRef('#20 x')).toBeNull();
    expect(slotUnset(' $ /* none */')).toBe(true);
  });
});
