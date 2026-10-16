/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EntityExtractor } from './entity-extractor.js';
import { extractPropertyRelFast } from './columnar-parser-relationships.js';
import { readPropertyDefinitionRefs, propertyDefinitionRefsOfValue } from './property-definition-refs.js';
import type { EntityRef } from './types.js';

// `IfcRelDefinesByProperties.RelatingPropertyDefinition` is written as `#20`,
// `(#20,#22)` or `IFCPROPERTYSETDEFINITIONSET((#20,#22))` (#7681). Rust reads
// all three (`DecodedEntity::get_refs`); this file holds the TypeScript readers
// to the SAME vector file so a spelling one side drops cannot go unnoticed.
// The Rust half is `rust/core/tests/property_definition_refs_parity.rs`.
// Skipped outside the monorepo, like the other `*.parity.test.ts` files here.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/property_definition_refs_vectors.json', import.meta.url),
);

interface Vector {
  name: string;
  attr5: string;
  decodes?: boolean;
  decodedReader?: boolean;
  refs: number[] | null;
}

const vectors: Vector[] = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, 'utf8')).cases
  : [];

const record = (attr5: string) => `#1=IFCRELDEFINESBYPROPERTIES('g',$,$,$,(#50),${attr5});`;
const bytesOf = (text: string) => new TextEncoder().encode(text);

function decodedAttr5(text: string): unknown {
  const buffer = bytesOf(text);
  const ref: EntityRef = { expressId: 1, type: 'IFCRELDEFINESBYPROPERTIES', byteOffset: 0, byteLength: buffer.length, lineNumber: 1 };
  return new EntityExtractor(buffer).extractEntity(ref)?.attributes[5];
}

describe.skipIf(vectors.length === 0)('RelatingPropertyDefinition: parity with the Rust reader (#7681)', () => {
  it('has the shared vectors', () => {
    expect(vectors.length).toBeGreaterThan(15);
  });

  for (const v of vectors) {
    describe(v.name, () => {
      const text = record(v.attr5);
      const buffer = bytesOf(text);
      const want = v.refs ?? [];

      it('byte reader returns the written ids (Rust get_refs)', () => {
        // Position at attribute 5's value, as `extractPropertyRelFast` does.
        const at = text.indexOf(v.attr5, text.indexOf('(#50),') + 6);
        expect(readPropertyDefinitionRefs(buffer, at, buffer.length)).toEqual(want);
      });

      it('extractPropertyRelFast keeps each set member once, or drops the relationship', () => {
        const rel = extractPropertyRelFast(buffer, 0, buffer.length);
        const distinct = [...new Set(want)];
        if (distinct.length === 0) expect(rel).toBeNull();
        else expect(rel).toEqual({ relatedObjects: [50], relatingDefs: distinct });
      });

      if (v.decodes !== false && v.decodedReader !== false) {
        it('decoded-value reader agrees', () => {
          expect(propertyDefinitionRefsOfValue(decodedAttr5(text))).toEqual(want);
        });
      }
    });
  }
});

describe('decoded-value reader: a number is not told apart from a reference (#7681)', () => {
  const text = record('(#20,1.5E3,.T.,#22)');
  it('the byte reader, like Rust, reads only the references', () => {
    const buffer = bytesOf(text);
    const at = text.indexOf('(#20,1.5E3');
    expect(readPropertyDefinitionRefs(buffer, at, buffer.length)).toEqual([20, 22]);
  });

  it('the decoded reader cannot, so a caller checks the entity exists', () => {
    const decoded = decodedAttr5(text);
    expect(propertyDefinitionRefsOfValue(decoded)).toEqual([20, 1500, 22]);
    const known = new Set([20, 22]);
    expect(propertyDefinitionRefsOfValue(decoded, (m) => (typeof m === 'number' && known.has(m) ? m : null))).toEqual([20, 22]);
  });
});
