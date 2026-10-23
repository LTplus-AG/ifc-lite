/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: `parseStepValue` splits a STEP list at top-level commas. A PAGE
 * directive's apostrophe operand (`'Para \S\' 5'`) is string text; ending the
 * literal there re-opened a string at the next quote and merged the list's
 * remaining members into it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseStepValue } from './step-serializers.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

describe('parseStepValue lists over PAGE-operand literals (#7589)', () => {
  it('decodes the literal and keeps the members after it', () => {
    expect(parseStepValue("('Para \\S\\' 5',#7,'Art \\S\\' 7')")).toEqual(['Para § 5', { ref: 7 }, 'Art § 7']);
  });

  for (const { name, literal } of vectors) {
    it(`${name}: yields exactly three members, the ref and the next string intact`, () => {
      const members = parseStepValue(`(${literal},#7,'x, #9')`);
      expect(members).toHaveLength(3);
      expect((members as unknown[])[1]).toEqual({ ref: 7 });
      expect((members as unknown[])[2]).toBe('x, #9');
    });
  }
});
