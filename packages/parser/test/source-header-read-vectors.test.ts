/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * F4-2 (#7778): `parseSourceHeader` reads the header the way Rust's
 * `parser::header` does. Both read rust/core/tests/fixtures/step_header_read_vectors.json
 * (rust/core/tests/step_header_read_vectors.rs is the other half), so a
 * keyword boundary, a bracket, an unclosed comment or the scan window cannot
 * drift between the two.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSourceHeader } from '../src/source-header.js';

interface Vector {
  name: string;
  text: string;
  padBefore?: number;
  schemas?: string[];
  description?: string[];
}

const doc: { cases: Vector[] } = JSON.parse(
  readFileSync(
    new URL('../../../rust/core/tests/fixtures/step_header_read_vectors.json', import.meta.url),
    'utf8',
  ),
);

describe('parseSourceHeader against the shared header-read vectors', () => {
  it('carries the whole fixture', () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(10);
  });

  for (const vector of doc.cases) {
    it(vector.name, () => {
      const text = vector.text.replace('{pad}', ' '.repeat(vector.padBefore ?? 0));
      const header = parseSourceHeader(new TextEncoder().encode(text));
      if (vector.schemas !== undefined) {
        expect(header?.schemaIdentifiers ?? []).toEqual(vector.schemas);
      }
      if (vector.description !== undefined) {
        expect(header?.description).toEqual(vector.description);
      }
    });
  }
});
