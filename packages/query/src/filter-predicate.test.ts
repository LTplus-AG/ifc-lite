/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { compareFilterValue, normalizeBooleanValue } from './filter-predicate.js';

describe('normalizeBooleanValue', () => {
  it('collapses every true-spelling to the same string', () => {
    expect(normalizeBooleanValue(true)).toBe('true');
    expect(normalizeBooleanValue('.T.')).toBe('true');
    expect(normalizeBooleanValue('true')).toBe('true');
    expect(normalizeBooleanValue('TRUE')).toBe('true');
  });

  it('collapses every false-spelling to the same string', () => {
    expect(normalizeBooleanValue(false)).toBe('false');
    expect(normalizeBooleanValue('.F.')).toBe('false');
    expect(normalizeBooleanValue('false')).toBe('false');
    expect(normalizeBooleanValue('FALSE')).toBe('false');
  });

  it('passes non-boolean values through unchanged', () => {
    expect(normalizeBooleanValue('IfcWall')).toBe('IfcWall');
    expect(normalizeBooleanValue(42)).toBe(42);
    expect(normalizeBooleanValue(null)).toBe(null);
  });
});

describe('compareFilterValue', () => {
  it('exists ignores the operand and checks non-null', () => {
    expect(compareFilterValue('REI60', 'exists', undefined)).toBe(true);
    expect(compareFilterValue(null, 'exists', undefined)).toBe(false);
  });

  it('= treats .T./true/TRUE as equal', () => {
    expect(compareFilterValue(true, '=', '.T.')).toBe(true);
    expect(compareFilterValue('.F.', '=', false)).toBe(true);
  });

  it('contains is case-insensitive', () => {
    expect(compareFilterValue('REI60', 'contains', 'rei')).toBe(true);
    expect(compareFilterValue('rei60', 'contains', 'REI')).toBe(true);
    expect(compareFilterValue('REI60', 'contains', 'xyz')).toBe(false);
  });

  it('numeric comparisons coerce both sides', () => {
    expect(compareFilterValue(5, '>', '3')).toBe(true);
    expect(compareFilterValue('2', '<', 3)).toBe(true);
  });
});
