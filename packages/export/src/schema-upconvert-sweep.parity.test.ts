/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the schema-upconversion padding parity pin.
 *
 * `convertStepLine` pads the trailing optional attributes a newer target
 * schema APPENDED (#1416). The Rust port in
 * `rust/export/src/schema_convert.rs` did not — and it is the Rust one that
 * `ifc-lite export --format step --schema IFC4` runs, through `exportStep` in
 * the wasm bindings — so the two halves emitted different files for the same
 * conversion for two months. Both are now held to ONE fixture; the Rust half
 * is `rust/export/tests/schema_upconvert_parity.rs`. Follows the
 * `rooted-type-sweep.parity.test.ts` precedent.
 *
 * The fixture's padded rows are DERIVED from
 * `packages/data/src/ifc-schema/generated/entities-*.ts` (the types whose
 * source attribute NAME list is a strict prefix of the target's — the same
 * relation `isStrictAttrPrefix` tests at run time), so this side is not
 * circular: it pins the answer that generated data implies, and a regenerated
 * schema that changes a count fails here rather than silently changing what
 * `ifc-lite` writes.
 *
 * WHICH rows the fixture must contain is pinned on the Rust side only
 * (`fixture_names_every_padded_type`), which re-derives the universe from its
 * own tables. The count check below is a smoke test, not the coverage gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

interface SweepCase {
  why: string;
  from: IfcSchemaVersion;
  to: IfcSchemaVersion;
  line: string;
  expect: string;
}

// The fixture lives in the Rust crate so `include_str!` can reach it; this side
// resolves it relative to the source file. NOT guarded by `existsSync`: a
// missing fixture means the pin is not being enforced, which must fail loudly.
const fixturePath = fileURLToPath(
  new URL('../../../rust/export/tests/fixtures/schema_upconvert_sweep.json', import.meta.url),
);
const fixture: { cases: SweepCase[] } = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('convertStepLine matches the shared cross-language upconversion sweep', () => {
  it('the fixture is not empty or trivial', () => {
    expect(fixture.cases.length).toBeGreaterThan(100);
  });

  it('every case agrees with the Rust converter', () => {
    const mismatches = fixture.cases
      .map((c) => ({ c, got: convertStepLine(c.line, c.from, c.to) }))
      .filter(({ c, got }) => got !== c.expect)
      .map(({ c, got }) => `${c.from}->${c.to} [${c.why}]\n  in     ${c.line}\n  expect ${c.expect}\n  got    ${got}`);
    expect(mismatches).toEqual([]);
  });

  it('a reordered attribute list is never padded (negative control)', () => {
    // IFC2X3 IfcMaterialProperties is [Material]; IFC4 is
    // [Name, Description, Properties, Material]. Padding would read #8 as Name.
    expect(convertStepLine('#7=IFCMATERIALPROPERTIES(#8);', 'IFC2X3', 'IFC4')).toBe(
      '#7=IFCMATERIALPROPERTIES(#8);',
    );
  });
});
