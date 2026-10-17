/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5193: a corrupted numeric literal must not be silently truncated to its
// parseable prefix by any STEP token reader.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCompleteStepNumericLiteral } from './step-numeric-literal.js';
import { parseStepValue } from './step-serializers.js';

// F4-1 (#7778): the vectors `rust/core` reads in `numeric_literal_tests.rs`
// and `tokenizer_tests.rs`, so the two grammars cannot drift apart.
interface NumericVector {
  text: string;
  kind: 'integer' | 'real' | 'unrepresentable' | 'refused';
  /** Refused by Rust only because the INTEGER is beyond i64; the grammar holds. */
  grammar?: boolean;
}
const vectors = JSON.parse(
  readFileSync(new URL('../../../rust/core/tests/fixtures/step_numeric_vectors.json', import.meta.url), 'utf8'),
) as NumericVector[];

describe('isCompleteStepNumericLiteral shared vectors (F4-1)', () => {
  it.each(vectors.map((v) => [v.text, v] as const))('%j', (_text, v) => {
    expect(isCompleteStepNumericLiteral(v.text)).toBe(v.kind !== 'refused' || v.grammar === true);
  });
});

describe('isCompleteStepNumericLiteral', () => {
  it('accepts every legal STEP REAL/INTEGER form the issue pins', () => {
    expect(isCompleteStepNumericLiteral('1.')).toBe(true);
    expect(isCompleteStepNumericLiteral('.5')).toBe(true);
    expect(isCompleteStepNumericLiteral('1.E3')).toBe(true);
    expect(isCompleteStepNumericLiteral('+1.5')).toBe(true);
    expect(isCompleteStepNumericLiteral('123')).toBe(true);
    expect(isCompleteStepNumericLiteral('-3')).toBe(true);
    // Grammatically complete even though the double range cannot hold it --
    // overflow is a SEPARATE hazard this predicate is not responsible for.
    expect(isCompleteStepNumericLiteral('1.0E400')).toBe(true);
  });

  it('rejects a token whose parseFloat-consumed prefix does not cover it all', () => {
    expect(isCompleteStepNumericLiteral('1.52.3')).toBe(false);
    expect(isCompleteStepNumericLiteral('1.5abc')).toBe(false);
  });

  it('rejects a sign or a bare dot with no digit anywhere', () => {
    expect(isCompleteStepNumericLiteral('+')).toBe(false);
    expect(isCompleteStepNumericLiteral('-')).toBe(false);
    expect(isCompleteStepNumericLiteral('.')).toBe(false);
    expect(isCompleteStepNumericLiteral('')).toBe(false);
  });

  it('rejects an exponent marker with no digit after it', () => {
    expect(isCompleteStepNumericLiteral('1.E')).toBe(false);
    expect(isCompleteStepNumericLiteral('1.E+')).toBe(false);
  });
});

describe('parseStepValue numeric tokens (#5193)', () => {
  it('keeps a malformed literal as its raw token instead of truncating it', () => {
    expect(parseStepValue('1.52.3')).toBe('1.52.3');
    expect(parseStepValue('1.5abc')).toBe('1.5abc');
    expect(parseStepValue('(1.52.3,4.,5.)')).toEqual(['1.52.3', 4, 5]);
  });

  it('still reads every legal REAL/INTEGER form as a number', () => {
    expect(parseStepValue('1.')).toBe(1);
    expect(parseStepValue('.5')).toBe(0.5);
    expect(parseStepValue('1.E3')).toBe(1000);
    expect(parseStepValue('+1.5')).toBe(1.5);
    expect(parseStepValue('-3')).toBe(-3);
  });
});
