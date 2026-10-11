/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regex translation between the rule engine's unanchored JS search and an
 * IDS whole-value XSD pattern (#5225). Each accepted translation is checked
 * by behaviour: the XSD side (through `@ifc-lite/ids`'s own translator,
 * anchored as the checker anchors it) accepts exactly the samples the JS
 * side accepts.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { translateXsdRegex } from '@ifc-lite/ids';

// The changed-test oracle deletes new production files before re-running
// this test. Load them at runtime so a missing module fails an assertion
// instead of preventing collection (same pattern as
// `packages/mutations/src/effective-entity-enumeration.test.ts`).
const regexPath = './ids-regex.js';
const regex: typeof import('./ids-regex.js') | null = await import(regexPath).catch(() => null);
function idsPatternToJsRegex(...args: Parameters<typeof import('./ids-regex.js').idsPatternToJsRegex>): ReturnType<typeof import('./ids-regex.js').idsPatternToJsRegex> {
  assert.ok(regex, './ids-regex.js must exist');
  return regex.idsPatternToJsRegex(...args);
}
function jsRegexToIdsPattern(...args: Parameters<typeof import('./ids-regex.js').jsRegexToIdsPattern>): ReturnType<typeof import('./ids-regex.js').jsRegexToIdsPattern> {
  assert.ok(regex, './ids-regex.js must exist');
  return regex.jsRegexToIdsPattern(...args);
}

function xsdAccepts(xsd: string, value: string): boolean {
  return new RegExp(`^(?:${translateXsdRegex(xsd).pattern})$`, 'u').test(value);
}

describe('jsRegexToIdsPattern (#5225)', () => {
  const same: Array<[string, string, string[]]> = [
    ['abc', '', ['abc', 'xabcx', 'ab', '']],
    ['^W-\\d{3}$', '', ['W-104', 'W-1040', 'xW-104', 'W-١٠٤']],
    ['^Wall', '', ['Wall A', 'A Wall']],
    ['A|B', '', ['xA', 'B', 'C']],
    ['\\/tmp\\/', '', ['/tmp/', 'tmp']],
    ['[\\d.]+m', '', ['3.5m', 'm']],
    ['^(?:REI60|REI90)$', 'u', ['REI60', 'REI90', 'REI120', 'xREI60']],
    // JS `.` excludes U+2028/U+2029 as well as CR and LF; XSD `.` does not.
    ['^a.b$', '', ['axb', 'a\u2028b', 'a\u2029b', 'a\nb', 'a\rb']],
    ['^[.].+$', 'u', ['.x', '.\u2028', '.\u2029', '.\n', 'x\u2028']],
  ];
  for (const [source, flags, samples] of same) {
    it(`/${source}/${flags} accepts the same values as its IDS pattern`, () => {
      const converted = jsRegexToIdsPattern({ source, flags });
      assert.ok(converted.ok, converted.ok ? '' : converted.reason);
      const js = new RegExp(source, flags);
      for (const sample of samples) {
        assert.equal(xsdAccepts(converted.pattern, sample), js.test(sample), `${JSON.stringify(sample)} against ${converted.pattern}`);
      }
    });
  }

  const refused: Array<[string, string, RegExp]> = [
    ['\\bwall', '', /\\b means something different/],
    ['(\\w)\\1', '', /\\w means something different/],
    ['(a)\\1', '', /back-references/],
    ['a+?', '', /lazy quantifiers/],
    ['(?=a)b', '', /groups starting "\(\?"/],
    ['^a|b', '', /anchors combined with a top-level "\|"/],
    ['a$b', '', /only supported at the very start or end/],
    ['wall', 'i', /"i" flag/],
    ['wall', 'm', /"m" regex flag/],
    ['\\x41', '', /\\x has no XSD form/],
  ];
  for (const [source, flags, reason] of refused) {
    it(`refuses /${source}/${flags}`, () => {
      const converted = jsRegexToIdsPattern({ source, flags });
      assert.equal(converted.ok, false);
      assert.match(converted.ok ? '' : converted.reason, reason);
    });
  }
});

describe('idsPatternToJsRegex (#5225)', () => {
  it('anchors the pattern and keeps an interior XSD ^ and $ literal', () => {
    const converted = idsPatternToJsRegex('a^b$c');
    assert.ok(converted.ok);
    assert.equal(converted.pattern, '/^(?:a\\^b\\$c)$/u');
  });

  // The IDS checker drops a pattern-initial `^` and pattern-final `$` as
  // redundant anchors and reads every other `^` / `$` as a literal; the
  // import must accept exactly the values the checker accepts.
  const checkerAgrees: Array<[string, string[]]> = [
    ['^US$', ['US', '^US$', '^US', 'US$', 'xUS']],
    ['^.*$', ['', 'anything', '^x$']],
    ['^US', ['US', '^US']],
    ['US$', ['US', 'US$']],
    ['US$?', ['US', 'US$', 'US$$']],
    ['a^b$', ['ab', 'a^b', 'a^b$', 'a^b$$']],
    ['^^a$$', ['a', '^a$', '^a', 'a$']],
    ['\\^US\\$', ['US', '^US$', '^US', 'US$']],
    ['^US\\$', ['US', 'US$', '^US$']],
    ['[^$]$', ['a', '$', 'a$', '^']],
    ['[$^]', ['$', '^', 'a']],
    ['^', ['', '^']],
    ['$', ['', '$']],
    ['^$', ['', '^', '$', '^$']],
    ['', ['', 'a']],
  ];
  for (const [xsd, samples] of checkerAgrees) {
    it(`reads ${JSON.stringify(xsd)} as the IDS checker does`, () => {
      const converted = idsPatternToJsRegex(xsd);
      assert.ok(converted.ok, converted.ok ? '' : converted.reason);
      const body = /^\/(.*)\/u$/.exec(converted.pattern)![1];
      const js = new RegExp(body, 'u');
      for (const sample of samples) {
        assert.equal(js.test(sample), xsdAccepts(xsd, sample), `${JSON.stringify(sample)} against ${converted.pattern}`);
      }
    });
  }

  it('imports XSD . as matching U+2028 and U+2029 but not CR or LF', () => {
    const converted = idsPatternToJsRegex('a.b');
    assert.ok(converted.ok);
    const js = new RegExp(/^\/(.*)\/u$/.exec(converted.pattern)![1], 'u');
    for (const sample of ['a\u2028b', 'a\u2029b', 'axb']) assert.equal(js.test(sample), true, JSON.stringify(sample));
    for (const sample of ['a\nb', 'a\rb']) assert.equal(js.test(sample), false, JSON.stringify(sample));
  });

  it('imports ^US$ as a rule accepting US, not the literal ^US$', () => {
    const converted = idsPatternToJsRegex('^US$');
    assert.ok(converted.ok);
    assert.equal(converted.pattern, '/^(?:US)$/u');
  });

  it('round-trips an anchored IDS pattern through a rule back to IDS', () => {
    for (const [xsd, exported] of [['^US$', 'US'], ['a^b$', 'a\\^b'], ['^US\\$', 'US\\$']] as const) {
      const imported = idsPatternToJsRegex(xsd);
      assert.ok(imported.ok);
      const body = /^\/(.*)\/u$/.exec(imported.pattern)![1];
      const back = jsRegexToIdsPattern({ source: body, flags: 'u' });
      assert.ok(back.ok, back.ok ? '' : back.reason);
      assert.equal(back.pattern, exported);
    }
  });

  it('translates XSD \\d to the Unicode digit class it means', () => {
    const converted = idsPatternToJsRegex('W-\\d{3}');
    assert.ok(converted.ok);
    const body = /^\/(.+)\/u$/.exec(converted.pattern)![1];
    assert.equal(new RegExp(body, 'u').test('W-١٠٤'), true);
    assert.equal(new RegExp(body, 'u').test('xW-104'), false);
  });

  it('refuses a construct JS cannot express', () => {
    // A block name XML Schema does not define has no exact translation.
    const converted = idsPatternToJsRegex('\\p{IsNoSuchBlock}+');
    assert.equal(converted.ok, false);
    if (!converted.ok) assert.match(converted.reason, /IsNoSuchBlock/);
  });

  it('translates an XSD block escape to its code-point range (#7400)', () => {
    const converted = idsPatternToJsRegex('\\p{IsBasicLatin}+');
    assert.ok(converted.ok);
    const body = /^\/(.+)\/u$/.exec(converted.pattern)![1];
    assert.equal(new RegExp(body, 'u').test('abc-1'), true);
    assert.equal(new RegExp(body, 'u').test('ā'), false);
  });
});
