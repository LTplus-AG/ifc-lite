/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { compileNameMatcher, isNamePattern } from './name-pattern.js';

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
});
