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
