/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the strict STEP value / slot-split parity pin (F4
 * M-export-a, #7778). Core's `is_step_value` and `split_step_slots`
 * (`rust/core/src/parser/slots.rs`, via `slots_tests.rs`) are held to the SAME
 * file, so the two grammars cannot drift apart in prose: accepts and refusals
 * both, unlike `step_refuse_vectors.json`, which pins refusals only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { isStepValue } from './step-slot-grammar.js';

interface ValueRow {
  name: string;
  text: string;
  valid: boolean;
}
interface SplitRow {
  name: string;
  inner: string;
  slots: string[] | null;
}
interface Fixture {
  values: ValueRow[];
  splits: SplitRow[];
}

// NOT guarded by `existsSync`: a missing fixture means the pin is not being
// enforced, which must fail loudly.
const fixture: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/core/tests/fixtures/step_slot_vectors.json', import.meta.url)),
    'utf8',
  ),
);

describe('isStepValue agrees with the shared vectors', () => {
  it('the fixture carries rows (an empty sweep proves nothing)', () => {
    expect(fixture.values.length).toBeGreaterThan(50);
    expect(fixture.splits.length).toBeGreaterThan(15);
  });

  for (const row of fixture.values) {
    it(`${row.valid ? 'accepts' : 'refuses'}: ${row.name}`, () => {
      expect(isStepValue(row.text)).toBe(row.valid);
    });
  }

  it('refuses deep nesting instead of overflowing the stack', () => {
    const deep = '('.repeat(200_000) + ')'.repeat(200_000);
    expect(isStepValue(deep)).toBe(false);
    expect(splitTopLevelStepArguments(deep)).toBeNull();
  });
});

describe('splitTopLevelStepArguments agrees with the shared splits', () => {
  for (const row of fixture.splits) {
    it(row.name, () => {
      expect(splitTopLevelStepArguments(row.inner)).toEqual(row.slots);
    });
  }
});
