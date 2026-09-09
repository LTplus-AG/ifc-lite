/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { compareFilterValue, normalizeBooleanValue } from './filter-predicate.js';
import { findAllPropertiesInSets } from './pset-lookup.js';

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
  it('exists matches once the property was found, regardless of its value', () => {
    // A `where(pset, prop, 'exists')` caller only reaches `compareFilterValue`
    // after already confirming the property/quantity was present (see the
    // three `QueryBackendMethods` call sites, all guarded by a presence
    // check before this runs) — so `exists` here answers "was it found",
    // not "does it also carry a non-null value". An IFC
    // `IFCPROPERTYSINGLEVALUE('FireRating',$,$,$)` — a `$` nominal value,
    // which parses to `null` — genuinely exists in its pset.
    expect(compareFilterValue('REI60', 'exists', undefined)).toBe(true);
    expect(compareFilterValue(null, 'exists', undefined)).toBe(true);
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

  // A numeric operator against a non-numeric `expected` coerces through
  // `Number('abc')` -> `NaN`, and every comparison against `NaN` is `false`.
  // That is defensible (a caller error should not silently pass), but it had
  // no pinning test before this — #4094 touched this function to add
  // `matches`, so it is pinned here too.
  it('a numeric operator against a non-numeric expected value is false, not a throw', () => {
    expect(compareFilterValue(5, '>', 'abc')).toBe(false);
    expect(compareFilterValue(5, '<', 'abc')).toBe(false);
    expect(compareFilterValue(5, '>=', 'abc')).toBe(false);
    expect(compareFilterValue(5, '<=', 'abc')).toBe(false);
  });

  describe('matches (regex)', () => {
    it('tests the stored value against the pattern', () => {
      expect(compareFilterValue('WT01-Wall', 'matches', '^WT01')).toBe(true);
      expect(compareFilterValue('WT02-Wall', 'matches', '^WT01')).toBe(false);
    });

    it('is case-sensitive, unlike contains', () => {
      expect(compareFilterValue('REI60', 'matches', '^rei')).toBe(false);
      expect(compareFilterValue('rei60', 'matches', '^rei')).toBe(true);
    });

    it('coerces a non-string actual value before testing', () => {
      expect(compareFilterValue(60, 'matches', '^\\d+$')).toBe(true);
      expect(compareFilterValue(true, 'matches', '^true$')).toBe(true);
    });

    it('does not boolean-normalize: a pattern can target the raw STEP token', () => {
      // If `matches` normalized booleans first (like every other operator
      // does), `.T.` would become the string `'true'` before the regex ever
      // ran, and a pattern written against the raw STEP spelling would never
      // match a boolean-typed actual value.
      expect(compareFilterValue('.T.', 'matches', '^\\.T\\.$')).toBe(true);
    });

    // Was: "an invalid pattern does not throw -- it matches nothing" (returned
    // `false`). A review flagged that as inconsistent with this repo's
    // fail-loud precedent for caller-supplied input (`--limit`/`--offset`
    // validate up front with `fatal()` rather than silently clamping) --
    // fixed alongside the ReDoS guard below, since both are "a `matches`
    // pattern this module refuses to run" and should fail the same way.
    it('an invalid pattern throws, naming why, rather than silently matching nothing', () => {
      expect(() => compareFilterValue('anything', 'matches', '[unterminated')).toThrow(
        /invalid regular expression/i,
      );
    });

    // Measured: `new RegExp('^(a+)+$').test(subject)` on a non-matching
    // subject is exponential in subject length in V8's backtracking engine
    // (n=26 -> ~290ms, n=28 -> ~1.1s, n=30 -> multiple seconds, n=35 -> >30s,
    // killed). `compareFilterValue` must reject this shape before ever
    // calling `.test()`, not attempt the match and hope it finishes --
    // asserting only on elapsed time here, deliberately, so this test cannot
    // pass by accident if the rejection itself stops working but the pattern
    // happens to run fast on this particular subject.
    it('rejects a catastrophic nested-quantifier pattern before compiling, fast', () => {
      const start = performance.now();
      expect(() => compareFilterValue('a'.repeat(26) + '!', 'matches', '^(a+)+$')).toThrow(
        /nested quantifier|exponential/i,
      );
      const elapsed = performance.now() - start;
      // The unguarded pattern measured ~290ms at this exact length (n=26) --
      // a guarded rejection should be orders of magnitude faster than that,
      // not merely under some generous ceiling.
      expect(elapsed).toBeLessThan(50);
    });

    it('rejects an over-long pattern before compiling', () => {
      const longPattern = '^' + 'a'.repeat(300) + '$';
      expect(() => compareFilterValue('anything', 'matches', longPattern)).toThrow(
        /exceeds the .*-character limit/i,
      );
    });

    // #4318: a character-class-blind guard reads `)` inside `[)]` as a real
    // group-closer, desyncing its paren-depth tracking so the genuinely
    // catastrophic `(a+ ... a+)+` shape underneath is never recognised.
    // Measured on this pattern (subject 'a'.repeat(n) + '!'): n=22 ~18ms,
    // n=26 ~1s, n=30 ~4s -- exponential, the same shape `^(a+)+$` is
    // rejected for above. This module now delegates its shape check to
    // `@ifc-lite/regex-guard`'s `hasCatastrophicBacktrackingShape`, which is
    // character-class aware (skips from an unescaped `[` to its closing `]`
    // without treating parens inside it as group syntax).
    it('rejects the character-class bypass pattern before compiling, fast', () => {
      const start = performance.now();
      expect(() => compareFilterValue('a'.repeat(26) + '!', 'matches', '^(a+[)]?a+)+$')).toThrow(
        /nested quantifier|exponential/i,
      );
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    // Both directions: a pattern that merely *contains* a character class
    // with a paren in it -- a legitimate, common shape for an IDS or list
    // filter pattern -- must still be ACCEPTED, not rejected as if it were
    // the bypass shape above.
    it('still accepts a legitimate pattern containing a class with a paren', () => {
      expect(compareFilterValue('(exterior)', 'matches', '^[(].*[)]$')).toBe(true);
      expect(compareFilterValue('Wall-042', 'matches', '^Wall-[0-9]{3}$')).toBe(true);
    });

    it('still matches ordinary patterns unaffected by the new guard', () => {
      expect(compareFilterValue('REI60', 'matches', '^REI')).toBe(true);
      expect(compareFilterValue('SomeWall', 'matches', 'Wall.*')).toBe(true);
      expect(compareFilterValue('123', 'matches', '[0-9]+')).toBe(true);
      expect(compareFilterValue('abc', 'matches', '[0-9]+')).toBe(false);
    });

    // Compiling a `matches` pattern once and reusing it for every candidate
    // in a query (instead of `new RegExp(...)` per entity, the shape
    // `applyWhereFilter`/`matchesPropertyFilter` all called this in before)
    // must produce identical results to a fresh per-call compile -- the
    // cache is purely an optimization, and must not let one pattern's
    // compiled RegExp leak into another pattern's result, or make a
    // pattern's Nth evaluation disagree with its 1st.
    it('per-query (cached) compilation matches per-entity (uncached) compilation, across interleaved patterns', () => {
      const subjects = ['WT01-Wall', 'WT02-Wall', 'REI60', 'REI90', 'SomeWall', '12345'];
      const patterns = ['^WT01', '^REI', 'Wall$', '^[0-9]+$'];

      // Baseline: a fresh RegExp per call, exactly what the pre-fix code did
      // per candidate entity.
      const expected = subjects.map((s) => patterns.map((p) => new RegExp(p).test(s)));

      // Interleave patterns (as a real multi-filter query would across many
      // entities) to exercise the cache's key lookup, not just repeated use
      // of a single pattern.
      const actual = subjects.map((s) => patterns.map((p) => compareFilterValue(s, 'matches', p)));

      expect(actual).toEqual(expected);

      // Re-run the same patterns again (simulating a second query, or more
      // entities) -- cached compilation must still agree with fresh
      // compilation, not just on the first pass.
      const secondPass = subjects.map((s) => patterns.map((p) => compareFilterValue(s, 'matches', p)));
      expect(secondPass).toEqual(expected);
    });
  });
});

/**
 * `HeadlessBackend.query.entities()`, the MCP `backend-query.ts` handler,
 * and the viewer's `query-adapter.ts` all apply a property filter the same
 * way: find every same-named property across every same-named pset, then
 * (a) an `exists` filter matches as soon as one was found, value aside, and
 * (b) every other operator matches if ANY of the found properties satisfies
 * it (#3490 — a same-named pset can appear twice on one entity, e.g. type +
 * occurrence). This helper reproduces that exact shape so a future
 * divergence between the three call sites and this test is loud — see
 * `packages/cli/src/headless-backend.ts`, `packages/mcp/src/backend-query.ts`
 * and `apps/viewer/src/sdk/adapters/query-adapter.ts` for the real call
 * sites this mirrors.
 */
interface TestProp {
  readonly name: string;
  readonly value: unknown;
}
interface TestPset {
  readonly name: string;
  readonly properties: readonly TestProp[];
}

function applyBackendFilter(
  psets: readonly TestPset[],
  psetName: string,
  propName: string,
  operator: import('./filter-predicate.js').FilterComparisonOp,
  value: unknown,
): boolean {
  const matchingProps = findAllPropertiesInSets(psets, psetName, propName);
  if (matchingProps.length === 0) return false;
  if (operator === 'exists') return true;
  return matchingProps.some((prop) => compareFilterValue(prop.value, operator, value));
}

describe('backend filter-predicate agreement (CLI/MCP/viewer shared shape)', () => {
  it('exists matches a property present with a `$` (null) nominal value', () => {
    // `IFCPROPERTYSINGLEVALUE('FireRating',$,$,$)`: present in its pset,
    // no value set. `parsePropertyValue` returns `null` for the `$`
    // nominal value and still pushes the property.
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: null }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', 'exists', undefined)).toBe(true);
  });

  it('exists does not match when the property is absent entirely', () => {
    const psets: TestPset[] = [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', 'exists', undefined)).toBe(false);
  });

  it('any-match: `=` passes when the SECOND same-named pset satisfies it, not just the first', () => {
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', '=', 'REI60')).toBe(true);
  });

  it('any-match: `=` fails when NO same-named pset satisfies it', () => {
    const psets: TestPset[] = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    ];
    expect(applyBackendFilter(psets, 'Pset_WallCommon', 'FireRating', '=', 'REI90')).toBe(false);
  });
});
