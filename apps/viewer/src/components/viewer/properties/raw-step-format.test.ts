/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IfcAttributeValue } from '@ifc-lite/mutations';

import {
  extractRawStepTokens,
  serializeStepToken,
  isInlineEditableToken,
  parseRawStepInput,
} from './raw-step-format.js';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('extractRawStepTokens', () => {
  it('returns null for a non-positive byteLength', () => {
    const buf = bytesOf('#42=IFCWALL();');
    assert.strictEqual(extractRawStepTokens(buf, 0, 0), null);
    assert.strictEqual(extractRawStepTokens(buf, 0, -1), null);
  });

  it('tokenizes a simple entity body', () => {
    const text = "#42=IFCWALL('abc',#1,.T.,(1,2,3));";
    const buf = bytesOf(text);
    const tokens = extractRawStepTokens(buf, 0, text.length);
    assert.deepStrictEqual(tokens, ["'abc'", '#1', '.T.', '(1,2,3)']);
  });

  it('works without the trailing semicolon', () => {
    const text = "#42=IFCWALL('abc',#1)";
    const buf = bytesOf(text);
    const tokens = extractRawStepTokens(buf, 0, text.length);
    assert.deepStrictEqual(tokens, ["'abc'", '#1']);
  });

  it('returns null when the entity body cannot be parsed (mismatched parens)', () => {
    const text = "#42=IFCWALL('abc',#1;";
    const buf = bytesOf(text);
    assert.strictEqual(extractRawStepTokens(buf, 0, text.length), null);
  });

  it('does not split on a comma embedded inside a quoted string', () => {
    const text = "#1=IFCLABEL('a,b');";
    const buf = bytesOf(text);
    const tokens = extractRawStepTokens(buf, 0, text.length);
    assert.deepStrictEqual(tokens, ["'a,b'"]);
  });

  it('honours a doubled single-quote as an escaped quote inside a string', () => {
    const text = "#1=IFCLABEL('it''s a test');";
    const buf = bytesOf(text);
    const tokens = extractRawStepTokens(buf, 0, text.length);
    assert.deepStrictEqual(tokens, ["'it''s a test'"]);
  });

  it('reads only the requested byte slice, honouring byteOffset', () => {
    const prefix = 'XXXX';
    const entity = "#7=IFCWALL('x');";
    const text = prefix + entity;
    const buf = bytesOf(text);
    const tokens = extractRawStepTokens(buf, prefix.length, entity.length);
    assert.deepStrictEqual(tokens, ["'x'"]);
  });
});

describe('serializeStepToken', () => {
  it('serializes null and undefined as $', () => {
    assert.strictEqual(serializeStepToken(null), '$');
    // `undefined` is outside the static `IfcAttributeValue` type but the
    // function guards it explicitly (`value === undefined`) for callers that
    // reach it dynamically (e.g. an unset positional attribute lookup).
    assert.strictEqual(serializeStepToken(undefined as unknown as import('@ifc-lite/mutations').IfcAttributeValue), '$');
  });

  it('serializes booleans distinctly', () => {
    assert.strictEqual(serializeStepToken(true), '.T.');
    assert.strictEqual(serializeStepToken(false), '.F.');
  });

  it('serializes finite numbers verbatim and non-finite numbers as $', () => {
    assert.strictEqual(serializeStepToken(42), '42');
    assert.strictEqual(serializeStepToken(1.5), '1.5');
    assert.strictEqual(serializeStepToken(0), '0');
    assert.strictEqual(serializeStepToken(Number.NaN), '$');
    assert.strictEqual(serializeStepToken(Number.POSITIVE_INFINITY), '$');
  });

  it('passes through $ and * strings unchanged', () => {
    assert.strictEqual(serializeStepToken('$'), '$');
    assert.strictEqual(serializeStepToken('*'), '*');
  });

  it('passes through a reference string unchanged', () => {
    assert.strictEqual(serializeStepToken('#123'), '#123');
  });

  it('upper-cases an enum-shaped string', () => {
    assert.strictEqual(serializeStepToken('.area.'), '.AREA.');
    assert.strictEqual(serializeStepToken('.AREA.'), '.AREA.');
  });

  it('quotes a plain string and doubles embedded single quotes', () => {
    assert.strictEqual(serializeStepToken('My Column'), "'My Column'");
    assert.strictEqual(serializeStepToken("it's"), "'it''s'");
  });

  it('doubles a backslash the same way the STEP exporter does', () => {
    // The doc-comment says this function "mirrors serializeStepValue" in
    // @ifc-lite/export, which escapes a literal backslash as `\\` (doubled)
    // before it escapes quotes — see packages/export/src/step-serialization.ts
    // `escapeStepString`. A raw Windows path (`C:\Users\a`) or any string
    // containing a backslash must round-trip through the same doubling here,
    // or the "Raw STEP" tab shows a token that disagrees with what the real
    // exporter would write to disk for the identical overlay value.
    assert.strictEqual(serializeStepToken('C:\\Users\\a'), "'C:\\\\Users\\\\a'");
  });

  it('handles a value with both a backslash and a quote, backslash first', () => {
    assert.strictEqual(serializeStepToken("C:\\O'Brien"), "'C:\\\\O''Brien'");
  });

  it('serializes arrays recursively, comma-joined and wrapped in parens', () => {
    assert.strictEqual(serializeStepToken([1, 'a', null, true]), "(1,'a',$,.T.)");
  });

  it('serializes an empty array as ()', () => {
    assert.strictEqual(serializeStepToken([]), '()');
  });
});

describe('isInlineEditableToken', () => {
  it('treats an empty/whitespace token as editable', () => {
    assert.strictEqual(isInlineEditableToken(''), true);
    assert.strictEqual(isInlineEditableToken('   '), true);
  });

  it('treats a list token as not editable', () => {
    assert.strictEqual(isInlineEditableToken('(1,2,3)'), false);
  });

  it('treats a typed-value token as not editable, case-insensitively', () => {
    assert.strictEqual(isInlineEditableToken("IFCLABEL('x')"), false);
    assert.strictEqual(isInlineEditableToken("ifclabel('x')"), false);
  });

  it('treats a plain scalar token as editable', () => {
    assert.strictEqual(isInlineEditableToken('#42'), true);
    assert.strictEqual(isInlineEditableToken('.T.'), true);
    assert.strictEqual(isInlineEditableToken("'hello'"), true);
  });
});

describe('parseRawStepInput', () => {
  it('maps empty, $, and null (any case) to null value', () => {
    assert.deepStrictEqual(parseRawStepInput(''), { value: null });
    assert.deepStrictEqual(parseRawStepInput('$'), { value: null });
    assert.deepStrictEqual(parseRawStepInput('null'), { value: null });
    assert.deepStrictEqual(parseRawStepInput('NULL'), { value: null });
  });

  it('maps .T./.t. to true and .F./.f. to false', () => {
    assert.deepStrictEqual(parseRawStepInput('.T.'), { value: true });
    assert.deepStrictEqual(parseRawStepInput('.t.'), { value: true });
    assert.deepStrictEqual(parseRawStepInput('.F.'), { value: false });
    assert.deepStrictEqual(parseRawStepInput('.f.'), { value: false });
  });

  it('keeps a reference as-is', () => {
    assert.deepStrictEqual(parseRawStepInput('#77'), { value: '#77' });
  });

  it('upper-cases an enum value', () => {
    assert.deepStrictEqual(parseRawStepInput('.area.'), { value: '.AREA.' });
  });

  it('parses an integer', () => {
    assert.deepStrictEqual(parseRawStepInput('42'), { value: 42 });
    assert.deepStrictEqual(parseRawStepInput('-7'), { value: -7 });
  });

  it('parses real numbers in several notations, including scientific', () => {
    assert.deepStrictEqual(parseRawStepInput('1.5'), { value: 1.5 });
    assert.deepStrictEqual(parseRawStepInput('.5'), { value: 0.5 });
    assert.deepStrictEqual(parseRawStepInput('5.'), { value: 5 });
    assert.deepStrictEqual(parseRawStepInput('1e3'), { value: 1000 });
    assert.deepStrictEqual(parseRawStepInput('-1.5e-3'), { value: -0.0015 });
  });

  it('strips wrapping quotes and un-escapes doubled quotes', () => {
    assert.deepStrictEqual(parseRawStepInput("'foo'"), { value: 'foo' });
    assert.deepStrictEqual(parseRawStepInput("'it''s'"), { value: "it's" });
  });

  it('rejects list literals with an actionable error, without corrupting the value', () => {
    const result = parseRawStepInput('(1,2,3)');
    assert.deepStrictEqual(result, { error: 'Lists and typed values must be edited from the script panel' });
  });

  it('rejects typed-value literals the same way', () => {
    const result = parseRawStepInput("IFCLABEL('x')");
    assert.deepStrictEqual(result, { error: 'Lists and typed values must be edited from the script panel' });
  });

  it('falls back to treating an unrecognised token as a plain string', () => {
    assert.deepStrictEqual(parseRawStepInput('hello'), { value: 'hello' });
  });

  it('treats a bare single quote as a literal apostrophe, not an empty quoted string', () => {
    // A single "'" both starts and ends with a quote character (it's the same
    // character satisfying both checks), so without the `length >= 2` guard
    // this would be misread as an empty quoted string ({ value: '' }) instead
    // of the literal apostrophe the user typed.
    assert.deepStrictEqual(parseRawStepInput("'"), { value: "'" });
  });
});

describe('serializeStepToken / parseRawStepInput round-trip', () => {
  // The file header calls parseRawStepInput the inverse of the display side
  // and promises the round-trip "stays predictable". Nothing pinned that, so
  // when serializeStepToken started doubling backslashes the parse side kept
  // un-doubling only quotes: opening the inline editor on such a value and
  // pressing Enter with no edit re-serialized the already-doubled token and
  // doubled it again — 1 -> 2 -> 4 -> 8 backslashes per open/save round.
  function parsedValue(token: string): IfcAttributeValue {
    const result = parseRawStepInput(token);
    assert.ok('value' in result, `expected a value for ${token}, got ${JSON.stringify(result)}`);
    return result.value;
  }

  const cases: Array<[string, IfcAttributeValue]> = [
    ['a Windows path', String.raw`C:\Users\a`],
    ['a UNC share', String.raw`\\server\share`],
    ['a backslash and a quote together', String.raw`C:\O'Brien`],
    ['a trailing backslash', 'ends with\\'],
    ['a doubled quote', "it's a 'test'"],
    ['plain text', 'My Column'],
  ];

  for (const [label, value] of cases) {
    it(`round-trips ${label} unchanged`, () => {
      assert.deepStrictEqual(parsedValue(serializeStepToken(value)), value);
    });

    it(`is a fixed point for ${label} (a no-op edit does not grow the value)`, () => {
      const once = parsedValue(serializeStepToken(value));
      const twice = parsedValue(serializeStepToken(once));
      assert.deepStrictEqual(twice, value);
    });
  }

  it('does not decode a STEP escape directive the user typed as literal text', () => {
    // `\X2\00FC\X0\` is an encoded `ü` on disk, but a user who types those twelve
    // characters into the editor means them literally: the serializer doubles
    // each backslash, and the decoder must read the doubled form back as text
    // rather than resolving it to `ü`.
    const value = '\\X2\\00FC\\X0\\';
    assert.strictEqual(serializeStepToken(value), "'\\\\X2\\\\00FC\\\\X0\\\\'");
    assert.deepStrictEqual(parsedValue(serializeStepToken(value)), value);
  });
});
