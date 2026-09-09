/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { compileNameMatcher, isNamePattern, unsafeNamePatternReason } from './name-pattern.js';

describe('compileNameMatcher', () => {
  it('matches a plain name exactly and case-sensitively', () => {
    const m = compileNameMatcher('Qto_WallBaseQuantities');
    expect(m('Qto_WallBaseQuantities')).toBe(true);
    expect(m('Qto_SlabBaseQuantities')).toBe(false);
    expect(m('qto_wallbasequantities')).toBe(false);
  });

  it('treats a `/regex/` literal as a regular expression', () => {
    const m = compileNameMatcher('/Qto_.*BaseQuantities/');
    // The #1591 use case: one pattern spans several quantity sets.
    expect(m('Qto_WallBaseQuantities')).toBe(true);
    expect(m('Qto_SlabBaseQuantities')).toBe(true);
    expect(m('Qto_WallCommon')).toBe(false);
    expect(m('Pset_WallCommon')).toBe(false);
  });

  it('honours regex flags', () => {
    const m = compileNameMatcher('/qto_.*basequantities/i');
    expect(m('Qto_WallBaseQuantities')).toBe(true);
  });

  it('strips stateful g/y flags so cached matching stays deterministic', () => {
    // The matcher is cached and shared across rows; a global/sticky RegExp
    // advances lastIndex on each .test(), so without stripping g/y the same
    // name would alternate true/false. Repeated calls must be stable.
    const m = compileNameMatcher('/Qto_.*BaseQuantities/g');
    expect(m('Qto_WallBaseQuantities')).toBe(true);
    expect(m('Qto_WallBaseQuantities')).toBe(true);
    expect(m('Qto_SlabBaseQuantities')).toBe(true);
    expect(m('Pset_WallCommon')).toBe(false);
    expect(m('Pset_WallCommon')).toBe(false);
  });

  it('anchors are respected inside the literal', () => {
    const m = compileNameMatcher('/^Pset_/');
    expect(m('Pset_WallCommon')).toBe(true);
    expect(m('X_Pset_WallCommon')).toBe(false);
  });

  it('falls back to an exact literal match (and warns) on an invalid pattern', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const m = compileNameMatcher('/Qto_[/'); // unterminated character class
      expect(m('Qto_WallBaseQuantities')).toBe(false); // never silently matches
      expect(m('/Qto_[/')).toBe(true); // matches only its own literal text
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not treat a name with internal slashes as a pattern', () => {
    // Not slash-delimited at both ends → exact match, no regex.
    const m = compileNameMatcher('Pset_A/B');
    expect(m('Pset_A/B')).toBe(true);
    expect(m('Pset_AXB')).toBe(false);
  });
});

describe('isNamePattern', () => {
  it('recognises valid `/regex/` literals only', () => {
    expect(isNamePattern('/Qto_.*/')).toBe(true);
    expect(isNamePattern('/Qto_.*/i')).toBe(true);
    expect(isNamePattern('Qto_WallBaseQuantities')).toBe(false);
    expect(isNamePattern('/unterminated[/')).toBe(false); // malformed → not a pattern
  });

  it('still recognises a catastrophic-shaped pattern as the /regex/ form', () => {
    // isNamePattern only classifies syntax (does it compile at all) — merely
    // *constructing* a RegExp never runs it, so this cannot ReDoS. The
    // rejection lives in compileNameMatcher, not here.
    expect(isNamePattern('/(a+)+$/')).toBe(true);
  });
});

describe('ReDoS guard (via @ifc-lite/regex-guard)', () => {
  it('rejects a catastrophic-backtracking pattern quickly, without ever running it', () => {
    // If the guard were absent (or a no-op), this .test() would take
    // seconds (issue #4262 measured ~9s for n=30 on similar hardware); a
    // bound well under that proves the guard fired BEFORE any matching was
    // attempted, not that a slow match happened to finish fast.
    const start = performance.now();
    let caught: Error | undefined;
    try {
      compileNameMatcher('/(a+)+$/');
    } catch (err) {
      caught = err as Error;
    }
    const elapsedMs = performance.now() - start;

    expect(caught).toBeInstanceOf(Error);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('names the rejected pattern and the catastrophic-backtracking reason in the thrown message', () => {
    expect(() => compileNameMatcher('/(a+)+$/')).toThrow(
      /rejected name pattern "\/\(a\+\)\+\$\/".*catastrophic-backtracking shape/
    );
  });

  it('rejects a pattern over the length cap, naming the reason', () => {
    const long = '/' + 'a'.repeat(300) + '/';
    expect(() => compileNameMatcher(long)).toThrow(/exceeds 256-character limit/);
  });

  it('rejects the other textbook catastrophic shapes: (...+)*, (.*)+, (.*)*', () => {
    for (const body of ['(a+)*', '(.*)+', '(.*)*']) {
      expect(() => compileNameMatcher(`/${body}\$/`)).toThrow(/catastrophic-backtracking shape/);
    }
  });

  it('rejects a character-class bypass of a naive (non-class-aware) scan (#4318)', () => {
    // `[)]` is a class containing a literal `)`, not a group-closer. A guard
    // implementation that isn't character-class aware desyncs here and
    // never finds the real `(a+ ... a+)+` catastrophic shape underneath —
    // this package shipped exactly that regression once, when its vendored
    // copy of @ifc-lite/regex-guard fell behind the package's fix for
    // #4318. Asserting the rejection here, through compileNameMatcher
    // itself (not just inside @ifc-lite/regex-guard's own suite), means a
    // future drift between this package's dependency and the guard's real
    // behaviour reddens THIS package's tests, not only the guard's.
    expect(() => compileNameMatcher('/^(a+[)]?a+)+$/')).toThrow(/catastrophic-backtracking shape/);
    expect(() => compileNameMatcher('/(a{1,})+$/')).toThrow(/catastrophic-backtracking shape/);
  });

  it('leaves every pattern in the existing corpus unrejected and matching identically', () => {
    // Both directions, mirrored against the corpus already exercised above:
    // none of these are catastrophic-shaped or over the length cap, so they
    // must compile and match exactly as before this guard existed.
    expect(compileNameMatcher('/Qto_.*BaseQuantities/')('Qto_WallBaseQuantities')).toBe(true);
    expect(compileNameMatcher('/qto_.*basequantities/i')('Qto_WallBaseQuantities')).toBe(true);
    expect(compileNameMatcher('/^Pset_/')('Pset_WallCommon')).toBe(true);
    expect(compileNameMatcher('/(Wall|Slab)+/')('WallWallSlab')).toBe(true);
    expect(compileNameMatcher('Qto_WallBaseQuantities')('Qto_WallBaseQuantities')).toBe(true);
  });

  it('unsafeNamePatternReason is pure and never throws, even on a dangerous source', () => {
    expect(unsafeNamePatternReason('(a+)+$')).toMatch(/catastrophic-backtracking shape/);
    expect(unsafeNamePatternReason('Qto_.*BaseQuantities')).toBeUndefined();
    expect(unsafeNamePatternReason('a'.repeat(300))).toMatch(/exceeds 256-character limit/);
  });
});
