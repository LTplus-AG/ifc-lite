/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { splitTopLevelStepArgs } from './step-args.js';

interface Fixture {
  cases: Array<{ name: string; input: string }>;
}

const path = fileURLToPath(
  new URL('../../../../rust/export/tests/fixtures/step_refuse_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(path, 'utf8'));

describe('splitTopLevelStepArgs shared refusal parity (#4200)', () => {
  it('contains a non-vacuous shared corpus', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const vector of fixture.cases) {
    it(`refuses ${vector.name}`, () => {
      expect(splitTopLevelStepArgs(vector.input)).toBeNull();
    });
  }

  it('accepts a complete binary literal', () => {
    expect(splitTopLevelStepArgs(`'g',"0F",$`)).toEqual([`'g'`, '"0F"', '$']);
  });
});
