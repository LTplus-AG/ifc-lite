/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: the Raw STEP tab splits a record's arguments for display. A PAGE
 * directive's apostrophe operand (`'Para \S\' 5'`) is string text; ending the
 * literal there merged the next arguments into one token and shifted every
 * slot after it.
 */

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractRawStepTokens } from './raw-step-format.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

describe('extractRawStepTokens over PAGE-operand literals (#7589)', () => {
  for (const { name, literal } of vectors) {
    it(`${name}: keeps the literal whole and the slots after it aligned`, () => {
      const text = `#10=IFCWALL('guid',$,${literal},'see #9',#5,(#6,#7));`;
      const bytes = new TextEncoder().encode(text);
      assert.deepEqual(
        extractRawStepTokens(bytes, 0, bytes.length),
        ["'guid'", '$', literal, "'see #9'", '#5', '(#6,#7)'],
      );
    });
  }
});
