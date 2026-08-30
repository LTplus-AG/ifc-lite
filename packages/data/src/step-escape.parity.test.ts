/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the STEP-string-escape cross-language parity pin (#3300,
 * second half).
 *
 * The Rust escaper (`rust/export/src/step_text.rs`, `escape`, exercised by
 * `rust/export/tests/step_escape_parity.rs`) is held to the SAME fixture, so
 * the two implementations cannot drift apart silently. Mirrors
 * `csv-cell.parity.test.ts`, which does the same for the CSV-cell escaper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeStepString } from './step-serializers.js';

interface Vector {
  name: string;
  input: string;
  expected: string;
}

interface Fixture {
  cases: Vector[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this
// side resolves it relative to the source file. NOT guarded by `existsSync`:
// a missing fixture means the pin is not being enforced, which must fail
// loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/step_escape_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('escapeStepString matches the shared cross-language vectors', () => {
  it('the fixture actually carries cases (an empty sweep proves nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  for (const v of fixture.cases) {
    it(`vector: ${v.name}`, () => {
      expect(escapeStepString(v.input)).toBe(v.expected);
    });
  }
});
