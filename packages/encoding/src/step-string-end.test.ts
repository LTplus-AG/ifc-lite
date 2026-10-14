/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepStringLiteralEnd } from './step-string-end.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

describe('stepStringLiteralEnd (#7589)', () => {
  for (const { name, literal } of vectors) {
    it(`${name}: ends exactly at the literal's own closing quote`, () => {
      expect(stepStringLiteralEnd(`(${literal},'next')`, 1)).toBe(1 + literal.length);
    });
  }
  it('reports a literal that never closes', () => {
    expect(stepStringLiteralEnd("('a\\S\\'", 1)).toBe(-1);
    expect(stepStringLiteralEnd("('it''", 1)).toBe(-1);
  });
});
