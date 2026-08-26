/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two TypeScript STEP escapers must agree with each other (#3284).
 *
 * There are two, and one output file uses both: `@ifc-lite/data`'s writes the
 * HEADER, this package's writes the DATA section, and `serializeAttributeValue`
 * picks between them by whether the source token was already quoted. So a
 * disagreement is reachable inside a single entity, not just across files.
 *
 * They also both claim, in their doc comments, to match
 * `rust/export/src/step_text.rs::escape`. Two functions each asserting parity
 * with the other and with a third implementation is exactly the arrangement
 * where a drift goes unnoticed, which is what #3284 reported: one collapsed a
 * RUN of control characters to a single space while the other emitted one
 * space each.
 */
import { describe, it, expect } from 'vitest';
import { serializeValue } from '@ifc-lite/data';
import { escapeStepString as escapeExport } from './step-serialization.js';

/** `@ifc-lite/data`'s escaper is private, so reach it through the public
 *  `serializeValue`, which wraps the escaped text in quotes. Testing the public
 *  surface is the right level anyway: it is what the exporter actually calls. */
const escapeData = (s: string): string => {
  const q = serializeValue(s);
  return q.slice(1, -1);
};

describe('the two TypeScript STEP escapers agree (#3284)', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['a run of control characters', 'a\t\t\tb'],
    ['a single control character', 'a\tb'],
    ['mixed run and singles', '\na\t\tb\r\rc'],
    ['a control run at the edges', '\t\ta\t\t'],
    ['backslash and quote alongside controls', "a\\b'c\t\td"],
    ['no control characters at all', 'plain value'],
  ];

  it.each(cases)('%s', (_label, input) => {
    expect(escapeExport(input)).toBe(escapeData(input));
  });

  it('a run maps to one space per character, matching the Rust escaper', () => {
    // Rust's step_text::escape pushes one space per control char. Pinning the
    // shared value, not just that the two TS halves agree with each other —
    // two functions can agree and both be wrong.
    expect(escapeExport('a\t\t\tb')).toBe('a   b');
    expect(escapeData('a\t\t\tb')).toBe('a   b');
  });
});
