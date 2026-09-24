/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { PARSE_INVALID, parseValue } from '../src/csv-parse-value.js';

/**
 * A List cell has two accepted encodings, JSON and semicolon-separated, and
 * the branch used to pick between them by catching a `JSON.parse` throw. That
 * made every malformed JSON list look like the semicolon form: `[1,2` came
 * back as the one-element array `['[1,2']`, a fabricated value of exactly the
 * kind {@link PARSE_INVALID} exists to keep out of the model. The choice is
 * The choice is made in three steps instead: valid JSON wins, a semicolon is
 * the unambiguous marker of the other form, and only a cell that looks like
 * JSON, has no semicolon, and still will not parse is refused. Deciding on a
 * leading `[` alone was wrong the other way — `[EXT];[LOAD]` is a legitimate
 * semicolon list whose first element starts with `[`, and refusing it would
 * drop data that imported fine before.
 */
describe('parseValue: List cells', () => {
  it('parses a JSON list', () => {
    expect(parseValue('["a", "b"]', PropertyValueType.List)).toEqual(['a', 'b']);
  });

  it('parses a semicolon-separated list, trimming each entry', () => {
    expect(parseValue('a; b ;c', PropertyValueType.List)).toEqual(['a', 'b', 'c']);
  });

  it('rejects a malformed JSON list instead of wrapping the raw cell in an array', () => {
    expect(parseValue('[1,2', PropertyValueType.List)).toBe(PARSE_INVALID);
  });

  // A semicolon list whose first entry starts with `[` must stay a semicolon
  // list. Choosing the JSON branch on a leading `[` alone refused these, which
  // would have dropped cells that imported correctly before.
  it('keeps a semicolon list whose entries look bracketed', () => {
    expect(parseValue('[EXT];[LOAD]', PropertyValueType.List)).toEqual(['[EXT]', '[LOAD]']);
    expect(parseValue('[1,2];x', PropertyValueType.List)).toEqual(['[1,2]', 'x']);
    expect(parseValue('[1, 2] ;3', PropertyValueType.List)).toEqual(['[1, 2]', '3']);
  });

  it('parses an empty JSON list as an empty list, not as a one-entry list', () => {
    expect(parseValue('[]', PropertyValueType.List)).toEqual([]);
  });
});

/**
 * #5427: Real/Integer/Boolean cells must be a COMPLETE value of the type.
 * `parseFloat`/`parseInt` read the longest numeric prefix and every word but
 * true/yes/1 became `false`, so these all wrote a value the cell did not hold.
 * The invariant: a cell either parses to exactly what it says, or is refused.
 */
describe('parseValue: typed cells are the whole value or refused (#5427)', () => {
  it('refuses a numeric prefix, a decimal comma and a thousands separator in a Real cell', () => {
    for (const cell of ['12,5', '60abc', '1,250.5', '1 250', '12.5.1', 'NaN', 'Infinity', '0x10', '', ' ', '.', 'e5', '1e', '1e309']) {
      expect(parseValue(cell, PropertyValueType.Real), cell).toBe(PARSE_INVALID);
    }
  });

  it('reads plain, signed, fractional and exponent Real cells, ignoring surrounding whitespace', () => {
    expect(parseValue('12.5', PropertyValueType.Real)).toBe(12.5);
    expect(parseValue(' -0.25 ', PropertyValueType.Real)).toBe(-0.25);
    expect(parseValue('+.5', PropertyValueType.Real)).toBe(0.5);
    expect(parseValue('5.', PropertyValueType.Real)).toBe(5);
    expect(parseValue('1.2E-05', PropertyValueType.Real)).toBe(1.2e-5);
    expect(parseValue('0', PropertyValueType.Real)).toBe(0);
  });

  it('refuses a fractional, prefixed or imprecise Integer cell', () => {
    // 9007199254740993 is past 2^53 and would silently round to ...992.
    for (const cell of ['2.7', '12.0', '1e3', '7 storeys', '1,000', '', '9007199254740993']) {
      expect(parseValue(cell, PropertyValueType.Integer), cell).toBe(PARSE_INVALID);
    }
    expect(parseValue(' -7 ', PropertyValueType.Integer)).toBe(-7);
    expect(parseValue('9007199254740991', PropertyValueType.Integer)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses a word that is not a boolean spelling, including LOGICAL UNKNOWN', () => {
    for (const type of [PropertyValueType.Boolean, PropertyValueType.Logical]) {
      for (const cell of ['ja', 'wahr', 'unknown', 'UNKNOWN', 'maybe', '2', '', '.T.']) {
        expect(parseValue(cell, type), cell).toBe(PARSE_INVALID);
      }
      expect(parseValue(' Yes ', type)).toBe(true);
      expect(parseValue('FALSE', type)).toBe(false);
      expect(parseValue('0', type)).toBe(false);
    }
  });

  it('returns text cells as given', () => {
    expect(parseValue(' 12,5 ', PropertyValueType.Label)).toBe(' 12,5 ');
  });
});
