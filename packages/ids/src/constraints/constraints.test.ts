/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { matchConstraint } from './index.js';
import type {
  IDSSimpleValue,
  IDSPatternConstraint,
  IDSEnumerationConstraint,
  IDSBoundsConstraint,
} from '../types.js';

// ============================================================================
// matchConstraint — Simple Values
// ============================================================================

describe('matchConstraint — simpleValue', () => {
  const sv = (value: string): IDSSimpleValue => ({
    type: 'simpleValue',
    value,
  });

  it('matches exact string', () => {
    expect(matchConstraint(sv('hello'), 'hello')).toBe(true);
  });

  it('rejects different string', () => {
    expect(matchConstraint(sv('hello'), 'world')).toBe(false);
  });

  it('is case-sensitive by default', () => {
    expect(matchConstraint(sv('IFCWALL'), 'IfcWall')).toBe(false);
    expect(matchConstraint(sv('hello'), 'Hello')).toBe(false);
  });

  it('matches case-insensitively when option is set (IFC entity names)', () => {
    const ci = { caseInsensitive: true };
    expect(matchConstraint(sv('IFCWALL'), 'IfcWall', ci)).toBe(true);
    expect(matchConstraint(sv('IfcWall'), 'IFCWALL', ci)).toBe(true);
    expect(matchConstraint(sv('ifcwall'), 'IFCWALL', ci)).toBe(true);
  });

  it('matches numeric values with tolerance', () => {
    expect(matchConstraint(sv('3.14'), 3.14)).toBe(true);
    expect(matchConstraint(sv('3.14'), 3.1400005)).toBe(true); // within 1e-6
    expect(matchConstraint(sv('3.14'), 3.15)).toBe(false);
  });

  it('matches numeric string against numeric string', () => {
    expect(matchConstraint(sv('42'), '42')).toBe(true);
    expect(matchConstraint(sv('42'), '42.0000005')).toBe(true); // within tolerance
  });

  it('matches boolean true', () => {
    expect(matchConstraint(sv('true'), true)).toBe(true);
    expect(matchConstraint(sv('1'), true)).toBe(true);
    expect(matchConstraint(sv('false'), true)).toBe(false);
  });

  it('matches boolean false', () => {
    expect(matchConstraint(sv('false'), false)).toBe(true);
    expect(matchConstraint(sv('0'), false)).toBe(true);
    expect(matchConstraint(sv('true'), false)).toBe(false);
  });

  it('matches boolean string values (case-sensitive)', () => {
    expect(matchConstraint(sv('true'), 'true')).toBe(true);
    expect(matchConstraint(sv('false'), 'false')).toBe(true);
    expect(matchConstraint(sv('true'), 'false')).toBe(false);
    // Case mismatch without caseInsensitive option
    expect(matchConstraint(sv('TRUE'), 'true')).toBe(true); // boolean comparison still works
    expect(matchConstraint(sv('false'), 'FALSE')).toBe(true); // boolean comparison still works
  });

  it('returns false for null/undefined', () => {
    expect(matchConstraint(sv('anything'), null)).toBe(false);
    expect(matchConstraint(sv('anything'), undefined)).toBe(false);
  });

  it('handles empty string', () => {
    expect(matchConstraint(sv(''), '')).toBe(true);
    expect(matchConstraint(sv(''), 'notempty')).toBe(false);
  });
});

// ============================================================================
// matchConstraint — Pattern
// ============================================================================

describe('matchConstraint — pattern', () => {
  const pat = (pattern: string): IDSPatternConstraint => ({
    type: 'pattern',
    pattern,
  });

  it('matches simple regex', () => {
    expect(matchConstraint(pat('Wall.*'), 'Wall_001')).toBe(true);
    expect(matchConstraint(pat('Wall.*'), 'Slab_001')).toBe(false);
  });

  it('anchors the match to the full string', () => {
    // Pattern should match entire string, not just a substring
    expect(matchConstraint(pat('Wall'), 'Wall')).toBe(true);
    expect(matchConstraint(pat('Wall'), 'BigWall')).toBe(false);
    expect(matchConstraint(pat('Wall'), 'WallBig')).toBe(false);
  });

  it('is case-sensitive (per XSD/IDS spec)', () => {
    expect(matchConstraint(pat('IFCWALL'), 'IfcWall')).toBe(false);
    expect(matchConstraint(pat('ifcwall'), 'IFCWALL')).toBe(false);
    expect(matchConstraint(pat('IFCWALL'), 'IFCWALL')).toBe(true);
    expect(matchConstraint(pat('IfcWall'), 'IfcWall')).toBe(true);
  });

  it('converts XSD \\i to initial name char class', () => {
    // \i matches [A-Za-z_:]
    expect(matchConstraint(pat('\\i.*'), 'abc')).toBe(true);
    expect(matchConstraint(pat('\\i.*'), '_test')).toBe(true);
  });

  it('converts XSD \\c to name char class', () => {
    // \c matches [A-Za-z0-9._:-]
    expect(matchConstraint(pat('\\c+'), 'a.b-c:1')).toBe(true);
  });

  it('handles \\p{...} unicode categories as dot', () => {
    expect(matchConstraint(pat('\\p{L}+'), 'hello')).toBe(true);
  });

  it('returns false for invalid regex', () => {
    // Unbalanced brackets should not throw, just return false
    expect(matchConstraint(pat('[invalid'), 'test')).toBe(false);
  });

  it('matches number converted to string', () => {
    expect(matchConstraint(pat('[0-9]+\\.?[0-9]*'), 3.14)).toBe(true);
  });
});

// ============================================================================
// matchConstraint — Enumeration
// ============================================================================

describe('matchConstraint — enumeration', () => {
  const enumC = (values: string[]): IDSEnumerationConstraint => ({
    type: 'enumeration',
    values,
  });

  it('matches single value', () => {
    expect(matchConstraint(enumC(['IFCWALL']), 'IFCWALL')).toBe(true);
  });

  it('matches one of multiple values', () => {
    const c = enumC(['IFCWALL', 'IFCSLAB', 'IFCBEAM']);
    expect(matchConstraint(c, 'IFCSLAB')).toBe(true);
    expect(matchConstraint(c, 'IFCCOLUMN')).toBe(false);
  });

  it('is case-sensitive by default', () => {
    expect(matchConstraint(enumC(['IFCWALL']), 'IfcWall')).toBe(false);
    expect(matchConstraint(enumC(['IfcWall']), 'IFCWALL')).toBe(false);
  });

  it('matches case-insensitively when option is set', () => {
    const ci = { caseInsensitive: true };
    expect(matchConstraint(enumC(['IFCWALL']), 'IfcWall', ci)).toBe(true);
    expect(matchConstraint(enumC(['IfcWall']), 'IFCWALL', ci)).toBe(true);
  });

  it('matches numeric values with tolerance', () => {
    expect(matchConstraint(enumC(['3.14', '2.71']), 3.14)).toBe(true);
    expect(matchConstraint(enumC(['3.14', '2.71']), 2.7100005)).toBe(true);
    expect(matchConstraint(enumC(['3.14', '2.71']), 9.99)).toBe(false);
  });

  it('returns false when nothing matches', () => {
    expect(matchConstraint(enumC(['A', 'B', 'C']), 'D')).toBe(false);
  });

});

// ============================================================================
// matchConstraint — Bounds
// ============================================================================

describe('matchConstraint — bounds', () => {
  const bounds = (
    opts: Partial<IDSBoundsConstraint>
  ): IDSBoundsConstraint => ({
    type: 'bounds',
    ...opts,
  });

  it('minExclusive — fails at exact boundary', () => {
    expect(matchConstraint(bounds({ minExclusive: 10 }), 10)).toBe(false);
  });

  it('minExclusive — passes above boundary', () => {
    expect(matchConstraint(bounds({ minExclusive: 10 }), 10.001)).toBe(true);
  });

  it('maxExclusive — fails at exact boundary', () => {
    expect(matchConstraint(bounds({ maxExclusive: 100 }), 100)).toBe(false);
  });

  it('maxExclusive — passes below boundary', () => {
    expect(matchConstraint(bounds({ maxExclusive: 100 }), 99.999)).toBe(true);
  });

  it('combined minInclusive + maxInclusive range', () => {
    const c = bounds({ minInclusive: 0, maxInclusive: 100 });
    expect(matchConstraint(c, 0)).toBe(true);
    expect(matchConstraint(c, 50)).toBe(true);
    expect(matchConstraint(c, 100)).toBe(true);
    expect(matchConstraint(c, -1)).toBe(false);
    expect(matchConstraint(c, 101)).toBe(false);
  });

  it('combined minExclusive + maxExclusive range', () => {
    const c = bounds({ minExclusive: 0, maxExclusive: 100 });
    expect(matchConstraint(c, 0)).toBe(false);
    expect(matchConstraint(c, 50)).toBe(true);
    expect(matchConstraint(c, 100)).toBe(false);
  });

  it('returns false for non-numeric actual value', () => {
    expect(matchConstraint(bounds({ minInclusive: 0 }), 'abc')).toBe(false);
  });

  it('parses string numbers', () => {
    expect(matchConstraint(bounds({ minInclusive: 0, maxInclusive: 100 }), '50')).toBe(true);
  });

  it('uses strict comparison at boundaries (no implicit tolerance)', () => {
    // Per upstream IfcOpenShell, bound checks compare strictly so a
    // value just below `minInclusive` fails (mirrors fixture
    // `tolerance/fail-comparison_tolerance_for_floating_point_range_greater_than_zero_inclusive`).
    expect(matchConstraint(bounds({ minInclusive: 10 }), 10 - 0.5e-6)).toBe(false);
    expect(matchConstraint(bounds({ minInclusive: 10 }), 10 - 2e-5)).toBe(false);
    expect(matchConstraint(bounds({ minInclusive: 10 }), 10)).toBe(true);
  });

  it('no bounds specified accepts any number', () => {
    expect(matchConstraint(bounds({}), 999)).toBe(true);
    expect(matchConstraint(bounds({}), -999)).toBe(true);
  });
});

// ============================================================================
// matchConstraint — unknown type
// ============================================================================


