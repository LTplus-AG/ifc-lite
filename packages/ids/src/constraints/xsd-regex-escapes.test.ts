/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * XSD regex escapes, block escapes and the absence of anchors, checked
 * against XML Schema Part 2 Appendix F semantics through the real matcher
 * (#7400). Each expectation is what an XML Schema processor gives.
 */

import { describe, expect, it } from 'vitest';
import { UnsafeRegexPatternError } from '@ifc-lite/regex-guard';

import { matchConstraint } from './index.js';
import { translateXsdRegex } from './xsd-regex.js';
import type { IDSPatternConstraint } from '../types.js';

const pat = (pattern: string): IDSPatternConstraint => ({ type: 'pattern', pattern });
const m = (pattern: string, value: string): boolean => matchConstraint(pat(pattern), value);

describe('XSD regex: negated multi-char escapes inside a class (#7400)', () => {
  it('[\\W] matches only non-word characters', () => {
    for (const v of ['abc', 'ā', 'abc-1', 'US']) expect(m('[\\W]+', v)).toBe(false);
    expect(m('[\\W]+', '-. ')).toBe(true);
  });

  it('[\\I] and [\\C] are the complements of \\i and \\c', () => {
    expect(m('[\\I]', '1')).toBe(true);
    expect(m('[\\I]', 'a')).toBe(false);
    expect(m('[\\C]+', ' !')).toBe(true);
    expect(m('[\\C]', 'a')).toBe(false);
    expect(m('[\\C]', '-')).toBe(false);
  });

  it('[\\S] excludes exactly the four XSD whitespace characters', () => {
    expect(m('[\\S]+', 'a b')).toBe(true);
    expect(m('[\\S]', ' ')).toBe(false);
    expect(m('[\\S]', '\t')).toBe(false);
  });

  it('mixes a negated escape with ordinary members', () => {
    expect(m('[a\\W]+', 'a-a.')).toBe(true);
    expect(m('[a\\W]+', 'ab')).toBe(false);
    expect(m('[\\D\\W]+', 'x-')).toBe(true);
  });

  it('a negated class containing a negated escape is an intersection', () => {
    // [^a\W] = \w minus a.
    expect(m('[^a\\W]+', 'bc1')).toBe(true);
    expect(m('[^a\\W]', 'a')).toBe(false);
    expect(m('[^a\\W]', '-')).toBe(false);
    // [^\W\D] = \w and \d = digits.
    expect(m('[^\\W\\D]+', '42')).toBe(true);
    expect(m('[^\\W\\D]', 'x')).toBe(false);
  });

  it('a literal ^ beside a complemented escape stays literal (review on #7410)', () => {
    // [\w^] = word characters plus caret.
    expect(m('[\\w^]+', 'a^b')).toBe(true);
    expect(m('[\\w^]', '-')).toBe(false);
    // [^^\w] = neither caret nor a word character.
    expect(m('[^^\\w]', '-')).toBe(true);
    expect(m('[^^\\w]', '^')).toBe(false);
    expect(m('[^^\\w]', 'a')).toBe(false);
    // [a^\W] = a, caret, or a non-word character.
    expect(m('[a^\\W]+', 'a^-')).toBe(true);
    expect(m('[a^\\W]', 'b')).toBe(false);
  });

  it('composes with class subtraction', () => {
    expect(m('[\\w-[a]]+', 'bc')).toBe(true);
    expect(m('[\\w-[a]]', 'a')).toBe(false);
    expect(m('[\\w-[a]]', '-')).toBe(false);
    expect(m('[\\W-[\\-]]+', '.,')).toBe(true);
    expect(m('[\\W-[\\-]]', '-')).toBe(false);
    expect(m('[a-z-[\\W]]+', 'abc')).toBe(true);
  });
});

describe('XSD regex: \\p{Is…} block escapes (#7400)', () => {
  it('\\p{IsBasicLatin} is U+0000..U+007F', () => {
    for (const v of ['abc', 'abc-1', 'US']) expect(m('\\p{IsBasicLatin}+', v)).toBe(true);
    expect(m('\\p{IsBasicLatin}+', 'ā')).toBe(false);
    expect(translateXsdRegex('\\p{IsBasicLatin}').supported).toBe(true);
  });

  it('\\P{Is…} and blocks inside classes, positive and negated', () => {
    expect(m('\\P{IsBasicLatin}', 'ā')).toBe(true);
    expect(m('\\P{IsBasicLatin}', 'a')).toBe(false);
    expect(m('[\\p{IsBasicLatin}\\p{IsLatinExtended-A}]+', 'aā')).toBe(true);
    expect(m('[^\\p{IsBasicLatin}]', 'ā')).toBe(true);
    expect(m('[^\\p{IsBasicLatin}]', 'a')).toBe(false);
    expect(m('[x\\P{IsBasicLatin}]+', 'xā')).toBe(true);
    expect(m('[x\\P{IsBasicLatin}]', 'a')).toBe(false);
  });

  it('covers supplementary-plane blocks and block names with hyphens', () => {
    expect(m('\\p{IsCJKUnifiedIdeographsExtensionB}', '\u{20000}')).toBe(true);
    expect(m('\\p{IsCJKUnifiedIdeographsExtensionB}', '一')).toBe(false);
    expect(m('\\p{IsLatin-1Supplement}', 'é')).toBe(true);
    expect(m('\\p{IsArabicPresentationForms-B}', 'ﹰ')).toBe(true);
  });

  it('PrivateUse and Specials span every range XSD lists for them', () => {
    expect(m('\\p{IsPrivateUse}', '')).toBe(true);
    expect(m('\\p{IsPrivateUse}', '\u{F0000}')).toBe(true);
    expect(m('\\p{IsPrivateUse}', '\u{10FFFD}')).toBe(true);
    expect(m('\\p{IsSpecials}', '﻿')).toBe(true);
    expect(m('\\p{IsSpecials}', '�')).toBe(true);
  });
});

describe('XSD regex: single-character escapes (#7400)', () => {
  it('\\- is a literal hyphen inside and outside a class', () => {
    expect(m('\\p{L}+\\-1', 'abc-1')).toBe(true);
    expect(m('\\p{L}+\\-1', 'abc')).toBe(false);
    expect(m('[a\\-z]+', 'a-z-')).toBe(true);
    expect(m('[a\\-z]', 'b')).toBe(false);
  });

  it('every XSD single-character escape matches its character', () => {
    const escapes = '\\n\\r\\t\\\\\\|\\.\\?\\*\\+\\(\\)\\{\\}\\-\\[\\]\\^';
    const literal = '\n\r\t\\|.?*+(){}-[]^';
    expect(m(escapes, literal)).toBe(true);
    expect(m(`[${escapes}]+`, literal)).toBe(true);
  });
});

describe('XSD regex: ^ and $ are ordinary characters (#7400)', () => {
  it('a $ is a literal dollar sign, even when quantified', () => {
    expect(m('US$?', 'US')).toBe(true);
    expect(m('US$?', 'US$')).toBe(true);
    expect(m('US$?', 'USD')).toBe(false);
    expect(m('a$b', 'a$b')).toBe(true);
  });

  it('a ^ outside a class is a literal caret, not an anchor', () => {
    expect(m('a^b', 'a^b')).toBe(true);
    expect(m('a^b', 'ab')).toBe(false);
    expect(m('a^', 'a^')).toBe(true);
    expect(m('$a', '$a')).toBe(true);
  });

  it('a pattern-initial ^ and pattern-final $ stay redundant anchors for compatibility (#1097)', () => {
    // `^.*$` is a common IDS idiom; the reference implementation's
    // re.fullmatch reads both as anchors.
    expect(m('^US$', 'US')).toBe(true);
    expect(m('^US$', '^US$')).toBe(false);
    // Only the edges: an inner or quantified `$` is still literal.
    expect(m('^US$?', 'US$')).toBe(true);
  });

  it('inside a class ^ negates only in first position, $ is always literal', () => {
    expect(m('[$^]+', '$^')).toBe(true);
    expect(m('[^^]', 'a')).toBe(true);
    expect(m('[^^]', '^')).toBe(false);
    expect(m('[^$]', '$')).toBe(false);
  });
});

describe('XSD regex: \\s, \\w and . follow Appendix F', () => {
  it('\\s is only space, tab, CR and LF', () => {
    expect(m('a\\sb', 'a b')).toBe(true);
    expect(m('a\\sb', 'a b')).toBe(false);
    expect(m('\\S', ' ')).toBe(true);
  });

  it('\\w is every character outside \\p{P}, \\p{Z} and \\p{C}', () => {
    // Symbols and marks are word characters; punctuation is not.
    expect(m('\\w+', 'a+=́')).toBe(true);
    expect(m('\\w', '_')).toBe(false);
    expect(m('\\w', '-')).toBe(false);
    expect(m('\\w', ' ')).toBe(false);
    expect(m('\\W', '_')).toBe(true);
  });

  it('. matches everything except CR and LF', () => {
    expect(m('.', ' ')).toBe(true);
    expect(m('.', '\n')).toBe(false);
  });
});

describe('XSD regex: constructs that cannot be evaluated are refused, not approximated', () => {
  it('an unknown block name is reported and fails validation visibly', () => {
    const r = translateXsdRegex('\\p{IsNoSuchBlock}+');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/IsNoSuchBlock/);
    expect(() => m('\\p{IsNoSuchBlock}+', 'abc')).toThrow(UnsafeRegexPatternError);
    expect(() => m('[a\\p{IsNoSuchBlock}]', 'a')).toThrow(/IsNoSuchBlock/);
  });

  it('a JS-only Unicode property is not an XSD category and is refused (review on #7410)', () => {
    for (const p of ['\\p{Emoji}', '\\P{Emoji}', '[a\\p{Emoji}]', '[^\\P{Emoji}]', '\\p{Script=Latin}', '\\p{Greek}', '\\p{Cs}']) {
      const r = translateXsdRegex(p);
      expect(r.supported, p).toBe(false);
      expect(r.reason, p).toMatch(/not an XSD/);
    }
    expect(() => m('\\p{Emoji}', '\u{1F600}')).toThrow(UnsafeRegexPatternError);
    expect(() => m('[a\\p{Emoji}]', 'a')).toThrow(/Emoji/);
  });

  it('every Appendix F category escape is accepted, positive and negated', () => {
    const cats = 'L Lu Ll Lt Lm Lo M Mn Mc Me N Nd Nl No P Pc Pd Ps Pe Pi Pf Po Z Zs Zl Zp S Sm Sc Sk So C Cc Cf Co Cn';
    for (const c of cats.split(' ')) {
      expect(translateXsdRegex(`\\p{${c}}[\\P{${c}}]`).supported, c).toBe(true);
    }
    expect(m('\\p{Lu}\\P{Lu}', 'Ab')).toBe(true);
  });

  it('an escape XSD does not define is reported', () => {
    const r = translateXsdRegex('a\\bc');
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/\\b/);
    expect(() => m('a\\bc', 'abc')).toThrow(UnsafeRegexPatternError);
  });
});
