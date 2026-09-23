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
  it('anchors the pattern and keeps XSD ^ and $ literal', () => {
    const converted = idsPatternToJsRegex('a^b$');
    assert.ok(converted.ok);
    assert.equal(converted.pattern, '/^(?:a\\^b\\$)$/u');
  });

  it('translates XSD \\d to the Unicode digit class it means', () => {
    const converted = idsPatternToJsRegex('W-\\d{3}');
    assert.ok(converted.ok);
    const body = /^\/(.+)\/u$/.exec(converted.pattern)![1];
    assert.equal(new RegExp(body, 'u').test('W-١٠٤'), true);
    assert.equal(new RegExp(body, 'u').test('xW-104'), false);
  });

  it('refuses a construct JS cannot express', () => {
    const converted = idsPatternToJsRegex('\\p{IsBasicLatin}+');
    assert.equal(converted.ok, false);
  });
});
