/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the rooted-type cross-language parity pin (#3015).
 *
 * The Rust classifier (`rust/export/src/rooted_type.rs::is_rooted_type`,
 * exercised by `rust/export/tests/rooted_type_parity.rs`) is held to the SAME
 * fixture, so the two "is this entity type an IfcRoot subtype" answers
 * cannot drift apart silently. Follows the precedent set by
 * `unit_scale_parity.rs` / `unit-scale.parity.test.ts` and
 * `csv_cell_parity.rs` / `csv-cell.parity.test.ts`.
 *
 * The fixture's `rooted` column was captured by RUNNING this exact function
 * (`getInheritanceChainAcrossSchemas(type).includes('IfcRoot')`, via
 * `rust/export/examples/dump_rooted_type_sweep.rs` +
 * a one-off script) against the exhaustive type sweep, then checked against
 * the Rust classifier — not hand-derived from reading either implementation.
 * Testing `isRootedType` (the real merged-guid.ts call site) against a
 * fixture generated from `getInheritanceChainAcrossSchemas` directly is not
 * circular: `isRootedType` is a thin wrapper around that same function today,
 * but the test exercises the actual production entry point, so a future
 * change to `isRootedType` that diverges from a bare chain lookup (an added
 * carve-out, a normalisation bug, ...) is still caught.
 *
 * WHICH rows the fixture must contain is pinned on the Rust side only
 * (`rooted_type_parity.rs::fixture_covers_the_whole_type_universe`), because
 * the universe is re-derived from Rust's own tables and this side has no way
 * to reconstruct it. The count check below is therefore a smoke test, not the
 * coverage gate: it would survive dropping dozens of rows. That is also why
 * the universe now includes the `ENTITY_NAME_ALIASES` keys — three of them
 * (`IFCSOLIDSTRATUM`, `IFCVOIDSTRATUM`, `IFCWATERSTRATUM`) classified
 * differently here than in Rust while both halves of this pair were green,
 * because no row named them (#3124 review).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isRootedType } from './merged-guid.js';

interface SweepCase {
  type: string;
  rooted: boolean;
}

interface Fixture {
  cases: SweepCase[];
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this side
// resolves it relative to the source file. NOT guarded by `existsSync`: a
// missing fixture means the pin is not being enforced, which must fail loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/rooted_type_sweep.json', import.meta.url),
);
const fixture: Fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('isRootedType matches the shared cross-language sweep', () => {
  it('the fixture exhaustively covers the type universe (an empty/tiny sweep proves nothing)', () => {
    expect(fixture.cases.length).toBeGreaterThan(900);
  });

  it('every case in the sweep agrees with the Rust classifier', () => {
    const mismatches = fixture.cases
      .filter((c) => isRootedType(c.type) !== c.rooted)
      .map((c) => `${c.type}: js=${isRootedType(c.type)} fixture=${c.rooted}`);
    expect(mismatches).toEqual([]);
  });
});
