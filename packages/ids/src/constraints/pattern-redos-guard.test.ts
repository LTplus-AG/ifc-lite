/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `matchConstraint` → `matchPattern` → `buildPatternRegex` path
 * (`match-family.ts`) compiles an `xs:pattern` facet's pattern into a
 * live `RegExp`. This pins that a catastrophic-backtracking or
 * over-long pattern is rejected (via `@ifc-lite/regex-guard`) BEFORE
 * that compile/match ever happens, and that an ordinary legitimate
 * IDS-style pattern is unaffected. See issue #4259.
 */

import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { matchConstraint } from './index.js';
import type { IDSPatternConstraint } from '../types.js';

const pattern = (p: string): IDSPatternConstraint => ({
  type: 'pattern',
  pattern: p,
});

describe('matchConstraint(pattern) — ReDoS guard', () => {
  it('rejects a catastrophic-backtracking pattern instead of hanging', () => {
    const start = performance.now();
    expect(() => matchConstraint(pattern('(a+)+b'), 'a'.repeat(35))).toThrow(
      UnsafeRegexPatternError
    );
    // Proof the guard fired before any backtracking match attempt:
    // an unguarded `(a+)+b` against 35 'a's would take seconds.
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('rejects an over-length pattern', () => {
    const long = `^${'a'.repeat(300)}$`;
    expect(() => matchConstraint(pattern(long), 'x')).toThrow(UnsafeRegexPatternError);
  });

  it('still matches a legitimate, realistic IDS-style pattern', () => {
    expect(matchConstraint(pattern('^Wall-[0-9]{3}$'), 'Wall-001')).toBe(true);
    expect(matchConstraint(pattern('^Wall-[0-9]{3}$'), 'Wall-abc')).toBe(false);
  });
});
