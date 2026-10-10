/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IDSConstraint } from '@ifc-lite/ids';
import { describe, expect, it } from 'vitest';
import { samplePattern } from './sample.js';
import { finiteValues, implies, interval, overlaps } from './solver.js';

const sv = (value: string): IDSConstraint => ({ type: 'simpleValue', value });
const en = (...values: string[]): IDSConstraint => ({ type: 'enumeration', values });
const pat = (pattern: string): IDSConstraint => ({ type: 'pattern', pattern });
const rng = (b: Partial<Record<'minInclusive' | 'minExclusive' | 'maxInclusive' | 'maxExclusive', number>>): IDSConstraint => ({ type: 'bounds', base: 'xs:double', ...b });

describe('overlaps', () => {
  it('decides finite sets exactly', () => {
    expect(overlaps(sv('EI60'), sv('EI60'))).toBe('yes');
    expect(overlaps(sv('EI60'), sv('EI90'))).toBe('no');
    expect(overlaps(en('A', 'B'), en('B', 'C'))).toBe('yes');
    expect(overlaps(en('A', 'B'), en('C'))).toBe('no');
    expect(overlaps(sv('ei60'), sv('EI60'))).toBe('no');
    expect(overlaps(sv('IFCWALL'), sv('IfcWall'), { caseInsensitive: true })).toBe('yes');
  });

  it('compares numeric literals as numbers', () => {
    expect(overlaps(sv('2'), sv('2.0'))).toBe('yes');
    expect(overlaps(sv('3'), rng({ minInclusive: 1, maxInclusive: 5 }))).toBe('yes');
    expect(overlaps(sv('6'), rng({ minInclusive: 1, maxInclusive: 5 }))).toBe('no');
  });

  it('decides intervals exactly, including open ends', () => {
    expect(overlaps(rng({ maxInclusive: 1 }), rng({ minInclusive: 1 }))).toBe('yes');
    expect(overlaps(rng({ maxInclusive: 1 }), rng({ minExclusive: 1 }))).toBe('no');
    expect(overlaps(rng({ maxExclusive: 1 }), rng({ minInclusive: 1 }))).toBe('no');
    expect(overlaps(rng({ minInclusive: 0, maxInclusive: 10 }), rng({ minInclusive: 5 }))).toBe('yes');
  });

  it('proves pattern overlap with a witness and never claims disjointness', () => {
    expect(overlaps(pat('EI[0-9]+'), pat('E.*'))).toBe('yes');
    expect(overlaps(pat('EI[0-9]+'), en('EI60', 'X'))).toBe('yes');
    expect(overlaps(pat('EI[0-9]+'), en('REI60'))).toBe('no');
    expect(overlaps(pat('A.*'), pat('B.*'))).toBe('unknown');
  });
});

describe('implies', () => {
  it('handles subsets, intervals and the unknown cases', () => {
    expect(implies(sv('EI60'), en('EI60', 'EI90'))).toBe('yes');
    expect(implies(en('EI60', 'EI30'), en('EI60', 'EI90'))).toBe('no');
    expect(implies(sv('IFCWALLTYPE'), pat('IFC.*TYPE'), { caseInsensitive: true })).toBe('yes');
    expect(implies(rng({ minInclusive: 2, maxInclusive: 3 }), rng({ minInclusive: 1 }))).toBe('yes');
    expect(implies(rng({ minInclusive: 0 }), rng({ minExclusive: 0 }))).toBe('no');
    expect(implies(rng({ minInclusive: 0, maxInclusive: 1 }), en('0', '1'))).toBe('no');
    expect(implies(pat('A.*'), pat('.*'))).toBe('unknown');
  });

  it('treats a degenerate interval as a single value', () => {
    expect(finiteValues(rng({ minInclusive: 2, maxInclusive: 2 }))).toEqual(['2']);
    expect(implies(rng({ minInclusive: 2, maxInclusive: 2 }), en('2', '3'))).toBe('yes');
  });

  it('ignores length and digit restrictions as intervals', () => {
    expect(interval({ type: 'bounds', minLength: 2 })).toBeUndefined();
  });
});

describe('samplePattern', () => {
  it('produces members for common shapes', () => {
    const check = (p: string) => samplePattern(p).filter((s) => new RegExp(`^(?:${p})$`, 'u').test(s));
    expect(check('EI[0-9]{2,3}').length).toBeGreaterThan(0);
    expect(check('(A|B)C?').sort()).toEqual(['A', 'AC', 'B', 'BC']);
    expect(check('[a-z]+_[0-9]*').length).toBeGreaterThan(0);
  });

  it('is bounded on deep nesting', () => {
    const deep = `${'('.repeat(40)}a${')'.repeat(40)}`;
    expect(samplePattern(deep).length).toBeLessThanOrEqual(32);
  });
});
