/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { compileXsdRegex, translateXsdRegex } from './regex.js';

describe('translateXsdRegex', () => {
  it('passes plain JS-compatible regex through unchanged', () => {
    const r = translateXsdRegex('[A-Za-z]+');
    expect(r.supported).toBe(true);
    expect(r.pattern).toBe('[A-Za-z]+');
  });

  it('translates \\i, \\c and their negations', () => {
    expect(translateXsdRegex('\\i').pattern).toContain('\\p{L}');
    expect(translateXsdRegex('\\I').pattern).toContain('[^\\p{L}');
    expect(translateXsdRegex('\\c').pattern).toContain('\\p{L}');
    expect(translateXsdRegex('\\C').pattern).toContain('[^');
  });

  it('translates \\d / \\D / \\w / \\W to Unicode property escapes', () => {
    expect(translateXsdRegex('\\d+').pattern).toBe('\\p{Nd}+');
    expect(translateXsdRegex('\\D+').pattern).toBe('\\P{Nd}+');
    // XSD \w is everything outside \p{P}, \p{Z}, \p{C} (Appendix F, #7400).
    expect(translateXsdRegex('\\w+').pattern).toBe('[^\\p{P}\\p{Z}\\p{C}]+');
    expect(translateXsdRegex('\\W+').pattern).toBe('[\\p{P}\\p{Z}\\p{C}]+');
  });

  it('translates character-class subtraction exactly, as a negative lookahead (#5183)', () => {
    const r = translateXsdRegex('[a-z-[aeiou]]');
    expect(r.supported).toBe(true);
    expect(r.pattern).toBe('(?:(?![aeiou])[a-z])');
    // Nested, and with XSD escapes on either side translated in class mode.
    expect(translateXsdRegex('[a-z-[b-y-[c]]]').pattern).toBe('(?:(?!(?:(?![c])[b-y]))[a-z])');
    expect(translateXsdRegex('[\\w-[\\d]]').pattern).toBe('(?:(?![\\p{Nd}])[^\\p{P}\\p{Z}\\p{C}])');
  });

  it('refuses a subtraction it cannot delimit rather than guessing', () => {
    const r = translateXsdRegex('[a-z-[aeiou]');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/subtraction/i);
  });

  it('inlines multi-char escapes inside a character class (no nesting)', () => {
    // `[\w]` must not become the invalid nested class `[[\p{L}\p{Nd}]]`.
    expect(translateXsdRegex('[\\w]').pattern).toBe('[^\\p{P}\\p{Z}\\p{C}]');
    expect(translateXsdRegex('[\\d]').pattern).toBe('[\\p{Nd}]');
    expect(translateXsdRegex('[\\i]').pattern).toBe('[\\p{L}_:]');
    // Each result compiles under the `u` flag.
    for (const p of ['[\\w]', '[\\d]', '[\\i]']) {
      const r = translateXsdRegex(p);
      expect(r.supported).toBe(true);
      expect(() => new RegExp(r.pattern, 'u')).not.toThrow();
    }
  });

  it('translates Unicode block escapes to their code-point ranges (#7400)', () => {
    const r = translateXsdRegex('\\p{IsBasicLatin}+');
    expect(r.supported).toBe(true);
    expect(r.pattern).toBe('[\\u0000-\\u007F]+');
    // An unknown block name has no exact form and is reported.
    const unknown = translateXsdRegex('\\p{IsNoSuchBlock}+');
    expect(unknown.supported).toBe(false);
    expect(() => new RegExp(unknown.pattern, 'u')).not.toThrow();
    // A recognised category class still passes through verbatim.
    const ok = translateXsdRegex('\\p{Lu}+');
    expect(ok.supported).toBe(true);
    expect(ok.pattern).toBe('\\p{Lu}+');
  });

  it('preserves backslash escapes that are common to both dialects', () => {
    expect(translateXsdRegex('\\.').pattern).toBe('\\.');
    expect(translateXsdRegex('a\\\\b').pattern).toBe('a\\\\b');
  });
});

describe('compileXsdRegex', () => {
  it('returns ok for a clean XSD regex', () => {
    const r = compileXsdRegex('[A-Z]+_\\d+');
    expect(r.ok).toBe(true);
  });

  it('returns ok after \\i / \\c translation', () => {
    const r = compileXsdRegex('\\i\\c*');
    expect(r.ok).toBe(true);
  });

  it('returns error for genuinely invalid regex', () => {
    const r = compileXsdRegex('(unclosed');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('error');
  });

  it('compiles char-class subtraction: the runtime matcher evaluates it exactly (#5183)', () => {
    expect(compileXsdRegex('[a-z-[aeiou]]').ok).toBe(true);
  });

  it('returns error for empty pattern', () => {
    const r = compileXsdRegex('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('error');
  });
});
