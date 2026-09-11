/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  MAX_GUARDED_REGEX_PATTERN_LENGTH,
  UnsafeRegexPatternError,
  assertGuardedRegexPattern,
  compileGuardedRegex,
  hasCatastrophicBacktrackingShape,
} from './index.js';

describe('hasCatastrophicBacktrackingShape', () => {
  it('flags the textbook catastrophic forms', () => {
    expect(hasCatastrophicBacktrackingShape('(a+)+b')).toBe(true);
    expect(hasCatastrophicBacktrackingShape('(a+)*b')).toBe(true);
    expect(hasCatastrophicBacktrackingShape('(.*)+')).toBe(true);
    expect(hasCatastrophicBacktrackingShape('(.*)*')).toBe(true);
    expect(hasCatastrophicBacktrackingShape('(a+)+$')).toBe(true);
  });

  it('does not flag ordinary, realistic IDS-style patterns', () => {
    expect(hasCatastrophicBacktrackingShape('^Wall-[0-9]{3}$')).toBe(false);
    expect(hasCatastrophicBacktrackingShape('^[A-Z]{2}-[0-9]{4}$')).toBe(false);
    expect(hasCatastrophicBacktrackingShape('IfcWall|IfcWallStandardCase')).toBe(false);
    expect(hasCatastrophicBacktrackingShape('.*')).toBe(false);
    expect(hasCatastrophicBacktrackingShape('a+')).toBe(false);
  });

  it('flags a character-class bypass of the naive scan (#4318)', () => {
    // `[)]` is a class containing a literal `)`, not a group-closer. A scan
    // that isn't character-class aware desyncs here and never finds the
    // real `(a+ ... a+)+` catastrophic shape. Measured: this pattern takes
    // seconds to fail to match a ~30-character non-matching subject.
    expect(hasCatastrophicBacktrackingShape('^(a+[)]?a+)+$')).toBe(true);
  });

  it('does not flag a legitimate pattern that merely contains a class with a paren', () => {
    // These must stay ACCEPTED -- a fix that rejects every pattern
    // containing `[` would break real IDS/list-filter patterns.
    expect(hasCatastrophicBacktrackingShape('^[(].*[)]$')).toBe(false);
    expect(hasCatastrophicBacktrackingShape('^Wall-[0-9]{3}$')).toBe(false);
  });
});

describe('assertGuardedRegexPattern', () => {
  it('rejects a catastrophic-backtracking pattern', () => {
    expect(() => assertGuardedRegexPattern('(a+)+b')).toThrow(UnsafeRegexPatternError);
    try {
      assertGuardedRegexPattern('(a+)+b');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeRegexPatternError);
      expect((err as UnsafeRegexPatternError).reason).toContain('catastrophic');
    }
  });

  it('rejects a pattern over the length cap', () => {
    const long = 'a'.repeat(MAX_GUARDED_REGEX_PATTERN_LENGTH + 1);
    expect(() => assertGuardedRegexPattern(long)).toThrow(UnsafeRegexPatternError);
    try {
      assertGuardedRegexPattern(long);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as UnsafeRegexPatternError).reason).toContain('limit');
    }
  });

  it('accepts a legitimate IDS-style pattern without throwing', () => {
    expect(() => assertGuardedRegexPattern('^Wall-[0-9]{3}$')).not.toThrow();
    expect(() => assertGuardedRegexPattern('^[A-Z]{2,4}-[0-9]{1,6}$')).not.toThrow();
  });

  it('honours a caller-supplied maxLength override', () => {
    expect(() => assertGuardedRegexPattern('abcdef', { maxLength: 5 })).toThrow(
      UnsafeRegexPatternError
    );
    expect(() => assertGuardedRegexPattern('abcde', { maxLength: 5 })).not.toThrow();
  });
});

describe('compileGuardedRegex', () => {
  it('rejects a catastrophic pattern before ever compiling it (does not hang)', () => {
    const start = performance.now();
    expect(() => compileGuardedRegex('^(?:(a+)+b)$', 'u')).toThrow(UnsafeRegexPatternError);
    // Rejection must be near-instant — proof the guard fired before any
    // backtracking match attempt, not after one that happened to be fast.
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('compiles and correctly matches a legitimate pattern', () => {
    const re = compileGuardedRegex('^Wall-[0-9]{3}$', undefined);
    expect(re.test('Wall-001')).toBe(true);
    expect(re.test('Wall-abc')).toBe(false);
  });
});
