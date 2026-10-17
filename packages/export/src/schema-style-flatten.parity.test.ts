/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the `IfcPresentationStyleAssignment` flatten pin (D57).
 * The Rust half is `rust/export/tests/schema_style_flatten_parity.rs`; both run
 * `rust/export/tests/fixtures/schema_style_flatten_vectors.json`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IfcSchemaVersion } from './schema-converter.js';
import { StyleFlatten, convertStepLineFlattening } from './schema-style-flatten.js';

interface Case { why: string; from: IfcSchemaVersion; to: IfcSchemaVersion; records: string[]; expect: string[] }

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_style_flatten_vectors.json', import.meta.url)),
    'utf8',
  ),
);

describe('StyleFlatten matches the shared vectors (D57)', () => {
  it('the fixture is not trivial', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8);
  });

  for (const c of fixture.cases) {
    it(`${c.from} -> ${c.to}: ${c.why}`, () => {
      const styles = StyleFlatten.applies(c.from, c.to) ? StyleFlatten.fromRecords(c.records) : undefined;
      const out = c.records
        .map((r) => convertStepLineFlattening(styles, r, c.from, c.to))
        .filter((r): r is string => r !== null);
      expect(out).toEqual(c.expect);
    });
  }

  it('flattens a styled-item subtype and leaves other records alone', () => {
    const styles = StyleFlatten.fromRecords(['#2=IFCPRESENTATIONSTYLEASSIGNMENT((#3,#4));']);
    expect(styles.apply("#7=IFCANNOTATIONSURFACEOCCURRENCE(#9,(#2),$);")).toBe(
      '#7=IFCANNOTATIONSURFACEOCCURRENCE(#9,(#3,#4),$);',
    );
    expect(styles.apply("#7=IFCWALL('g',#2,$,$,$,$,$,$,$);")).toBe("#7=IFCWALL('g',#2,$,$,$,$,$,$,$);");
  });
});
