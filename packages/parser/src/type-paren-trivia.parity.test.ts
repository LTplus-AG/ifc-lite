/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EntityExtractor } from './entity-extractor.js';
import type { EntityRef, IfcAttributeValue } from './types.js';

// The Rust tokenizer (`rust/core/src/parser/tokenizer.rs`, via `ws` ->
// `skip_step_trivia`) and this TS extractor (whose regexes are built on
// `STEP_TRIVIA`) must agree on exactly which trivia is legal between a STEP
// type name and its `(`. They are pinned to ONE shared vector file so the two
// cannot drift (issue #3789); the Rust half is
// `rust/core/tests/type_paren_trivia_parity.rs`. Skip gracefully outside the
// monorepo, the same way the other `*.parity.test.ts` files here do.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/type_paren_trivia_vectors.json', import.meta.url),
);

interface Vector {
  name: string;
  record: string;
  trivia: 'entity' | 'typedValue';
  accepted: boolean;
  attributeCount?: number;
  typeName?: string;
  stringValue?: string;
}

/**
 * Decode one complete record, handing `extractEntity` a ref that spans it
 * exactly — the scanner's job is a separate question, and pinning it here
 * would test two layers at once.
 */
function extract(record: string) {
  const buffer = new TextEncoder().encode(record);
  const ref: EntityRef = {
    expressId: 1,
    type: 'IFCWALL',
    byteOffset: 0,
    byteLength: buffer.length,
    lineNumber: 1,
  };
  return new EntityExtractor(buffer).extractEntity(ref);
}

/**
 * A typed value decodes as the `[typeName, value]` pair that mirrors Rust's
 * `Token::TypedValue`; a plain list decodes as an array of values. The
 * fixture's typed-value cases never use a list whose first element is a
 * string, so the leading-string test separates the two.
 */
function typedValueName(attr: IfcAttributeValue | undefined): string | null {
  if (!Array.isArray(attr) || attr.length !== 2) return null;
  return typeof attr[0] === 'string' ? attr[0] : null;
}

const vectors: Vector[] = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, 'utf8')).cases
  : [];

describe.skipIf(vectors.length === 0)(
  'STEP trivia between a type name and its "(": parity with the Rust tokenizer (#3789)',
  () => {
    it('has the shared vectors', () => {
      expect(vectors.length).toBeGreaterThan(10);
    });

    for (const v of vectors.filter((c) => c.trivia === 'entity')) {
      it(`entity record: ${v.name}`, () => {
        const entity = extract(v.record);
        if (!v.accepted) {
          expect(entity).toBeNull();
          return;
        }
        expect(entity).not.toBeNull();
        expect(entity!.expressId).toBe(1);
        expect(entity!.attributes.length).toBe(v.attributeCount);
      });
    }

    for (const v of vectors.filter((c) => c.trivia === 'typedValue')) {
      it(`typed value: ${v.name}`, () => {
        const entity = extract(v.record);
        // Every typed-value vector sits inside a well-formed record, so the
        // record itself always decodes here; only the SHAPE of attribute 0
        // is under test.
        expect(entity).not.toBeNull();
        const attr = entity!.attributes[0];
        if (v.accepted) {
          expect(typedValueName(attr)).toBe(v.typeName);
          return;
        }
        // Rust rejects these records outright; this extractor's per-attribute
        // regex instead falls through to its plain-string branch and hands
        // back the raw text. Both are refusals to read a typed value, which
        // is the property the two halves share.
        expect(typedValueName(attr)).toBeNull();
        if (v.stringValue !== undefined) expect(attr).toBe(v.stringValue);
      });
    }
  },
);
