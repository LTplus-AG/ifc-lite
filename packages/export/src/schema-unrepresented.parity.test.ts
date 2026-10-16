/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * TypeScript half of the "no representation in the target schema" pin (#7742).
 * The Rust half is `rust/export/tests/schema_unrepresented_parity.rs`; both run
 * `rust/export/tests/fixtures/schema_unrepresented_vectors.json`. Before #7742
 * the Rust converter wrote IFC4X3-only resource records into an IFC4 file that
 * this one refuses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

interface Case {
  why: string;
  from: IfcSchemaVersion;
  to: IfcSchemaVersion;
  line: string;
  expect?: string;
  refuses?: boolean;
}

const fixture: { cases: Case[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_unrepresented_vectors.json', import.meta.url)),
    'utf8',
  ),
);

describe('convertStepLine matches the shared unrepresented-type vectors (#7742)', () => {
  it('the fixture is not trivial', () => {
    expect(fixture.cases.filter((c) => c.refuses).length).toBeGreaterThanOrEqual(8);
    expect(fixture.cases.some((c) => !c.refuses)).toBe(true);
  });

  // Compact and spaced (`#5 = TYPE (`, as Viadotto_Acerno writes): the spaced
  // form used to miss the record regex and pass through unconverted (#7742).
  const spaced = (line: string) => line.replace(/^(#\d+)=(\w+)\(/, '$1 = $2 (');
  for (const c of fixture.cases) {
    for (const line of [c.line, spaced(c.line)]) {
      it(`${c.from} -> ${c.to}: ${c.why} [${line === c.line ? 'compact' : 'spaced'}]`, () => {
        expect(line === c.line || line.startsWith('#5 = ')).toBe(true);
        if (c.refuses) {
          expect(() => convertStepLine(line, c.from, c.to)).toThrow(/no representation/);
          return;
        }
        const got = convertStepLine(line, c.from, c.to) ?? '';
        expect(got.replace(/IFCPROXY\('[^']*'/, 'IFCPROXY(<MINTED>')).toBe(c.expect);
      });
    }
  }
});
