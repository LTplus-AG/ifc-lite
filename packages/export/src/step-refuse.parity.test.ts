/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the STEP argument-list REFUSE parity pin (#4125).
 *
 * The Rust splitter (`rust/export/src/step_slot.rs`, `split_top_level_args`,
 * exercised by `rust/export/src/step_slot_tests.rs`) is held to the SAME
 * fixture, so the two implementations cannot drift apart silently. Mirrors
 * `step-escape.parity.test.ts`, which does the same for the STEP string
 * escaper — and exists for the same reason that one does: #4173 hardened this
 * splitter while the Rust one stayed permissive, and nothing said so, because
 * each side described the other in prose.
 *
 * Only the REFUSE side is pinned. What each splitter ACCEPTS is its caller's
 * choice and the two diverge on purpose; the fixture's own header says why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitTopLevelStepArguments } from './step-argument-parser.js';

interface Vector {
  name: string;
  why: string;
  input: string;
}

interface Fixture {
  cases: Vector[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this
// side resolves it relative to the source file. NOT guarded by `existsSync`:
// a missing fixture means the pin is not being enforced, which must fail
// loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/step_refuse_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('splitTopLevelStepArguments refuses the shared cross-language vectors', () => {
  it('the fixture actually carries cases (an empty sweep proves nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of fixture.cases) {
    it(`refuses: ${v.name}`, () => {
      expect(splitTopLevelStepArguments(v.input)).toBeNull();
    });
  }
});
