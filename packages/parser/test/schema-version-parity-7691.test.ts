/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7691 (PROCESSING-5 / SERVER-18): the Rust detector behind every server
 * `schema_version` and this parser's `detectSchemaVersion` must classify every
 * header the same way. The vectors are shared with the Rust test
 * (`rust/processing/src/processor/schema_detection_tests.rs`), so a rule
 * change on one side fails the other side's suite.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectSchemaVersion, parseSourceHeader } from '../src/source-header.js';

interface Vector { name: string; content: string; expected: string; pad?: number }

const { vectors }: { vectors: Vector[] } = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/schema_version_vectors.json', import.meta.url), 'utf8',
));

describe('detectSchemaVersion matches the Rust detector (#7691)', () => {
  it('has vectors', () => {
    expect(vectors.length).toBeGreaterThan(10);
  });
  for (const v of vectors) {
    it(v.name, () => {
      const bytes = new TextEncoder().encode(v.content.replace('{PAD}', 'x'.repeat(v.pad ?? 0)));
      expect(detectSchemaVersion(bytes, parseSourceHeader(bytes))).toBe(v.expected);
    });
  }
});
