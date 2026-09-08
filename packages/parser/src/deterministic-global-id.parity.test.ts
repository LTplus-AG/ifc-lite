/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the deterministic-GlobalId minting cross-language
 * parity pin (#3015).
 *
 * The Rust port (`rust/export/src/merged.rs::deterministic_global_id`,
 * exercised by `rust/export/tests/deterministic_global_id_parity.rs`) is
 * held to the SAME fixture, so the two mints cannot drift apart silently.
 * Follows the precedent set by `unit_scale_parity.rs` /
 * `unit-scale.parity.test.ts` and `csv_cell_parity.rs` /
 * `csv-cell.parity.test.ts`.
 *
 * The fixture's `expected` column was captured by RUNNING this exact
 * function, then checked against the Rust port — not hand-derived. It
 * includes the three pre-existing golden anchors from this file's sibling
 * `test/deterministic-global-id.test.ts` (task-0, '', IfcBuildingStorey/Level 3).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deterministicGlobalId } from './deterministic-global-id.js';

interface Vector {
  seed: string;
  expected: string;
}

interface Fixture {
  cases: Vector[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this side
// resolves it relative to the source file. NOT guarded by `existsSync`: a
// missing fixture means the pin is not being enforced, which must fail loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/deterministic_global_id_vectors.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('deterministicGlobalId matches the shared cross-language vectors', () => {
  it('the fixture actually carries cases (an empty vector set proves nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
  });

  for (const v of fixture.cases) {
    it(`seed: ${JSON.stringify(v.seed)}`, () => {
      expect(deterministicGlobalId(v.seed)).toBe(v.expected);
    });
  }
});
