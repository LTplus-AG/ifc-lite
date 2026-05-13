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
    expect(translateXsdRegex('\\w+').pattern).toBe('[\\p{L}\\p{Nd}]+');
    expect(translateXsdRegex('\\W+').pattern).toBe('[^\\p{L}\\p{Nd}]+');
  });

  it('flags character-class subtraction as unsupported', () => {
    const r = translateXsdRegex('[a-z-[aeiou]]');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/subtraction/i);
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

  it('returns warning for char-class subtraction', () => {
    const r = compileXsdRegex('[a-z-[aeiou]]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('warning');
  });

  it('returns error for empty pattern', () => {
    const r = compileXsdRegex('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.severity).toBe('error');
  });
});
