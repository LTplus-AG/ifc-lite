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

describe.skipIf(!existsSync(fixturePath))('decodeIfcString shared parity vectors', () => {
  const cases = (JSON.parse(readFileSync(fixturePath, 'utf8')) as { cases: Vector[] }).cases;

  it('fixture has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`matches the Rust decoder: ${c.name}`, () => {
      expect(decodeIfcString(c.encoded)).toBe(c.decoded);
    });
  }
});
