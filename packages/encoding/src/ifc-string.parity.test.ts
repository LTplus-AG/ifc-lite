/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeIfcString } from './ifc-string.js';

// The Rust step_encoding decoder and this TS decoder are pinned to ONE shared
// vector file so the two cannot drift. The fixture lives in the core crate;
// skip gracefully if this package is tested outside the monorepo layout.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/ifc_string_vectors.json', import.meta.url),
);

interface Vector {
  name: string;
  encoded: string;
  decoded: string;
}

/** End-to-end vector: the STEP literal's INNER bytes and the value a consumer must see. */
interface LiteralVector {
  name: string;
  raw: string;
  value: string;
}

interface Fixture {
  cases: Vector[];
  literal_cases: LiteralVector[];
}

describe.skipIf(!existsSync(fixturePath))('decodeIfcString shared parity vectors', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const cases = fixture.cases;

  it('fixture has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches the Rust decoder: ${c.name}`, () => {
      expect(decodeIfcString(c.encoded)).toBe(c.decoded);
    });
  }
});

// The decoders agreeing is only half the contract (#2323). `decodeIfcString`
// deliberately never touches quotes, so `''` is collapsed only if the caller
// un-doubles FIRST — the order every consumer here uses (entity-extractor,
// columnar-parser-attributes, source-header, mcp). Rust drives these same
// vectors through AttributeValue::from_token, so both engines are pinned to the
// composed behaviour a CSV/JSON/Parquet reader actually gets, not just to each
// other's decoder.
describe.skipIf(!existsSync(fixturePath))('STEP literal end-to-end parity vectors', () => {
  const literalCases = (JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture).literal_cases;

  it('fixture has literal cases', () => {
    expect(literalCases.length).toBeGreaterThan(0);
  });

  for (const c of literalCases) {
    it(`matches the Rust attribute path: ${c.name}`, () => {
      expect(decodeIfcString(c.raw.replace(/''/g, "'"))).toBe(c.value);
    });
  }
});
