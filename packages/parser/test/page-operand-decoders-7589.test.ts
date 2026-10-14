/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7589: the attribute walkers behind the columnar store and the entity
 * extractor read a `\S\` PAGE directive's apostrophe operand as text, as the
 * entity scanners have since #7540. Each one used to end `'Para \S\' 5'` at
 * the operand, so the rest of the literal was read as structure: the Name
 * slot, the Representation slot (hasGeometry) and relationship reference
 * slots all landed on the wrong attribute.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { decodeIfcString } from '@ifc-lite/encoding';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import type { EntityRef } from '../src/types.js';

const vectors: { name: string; literal: string }[] = JSON.parse(readFileSync(
  new URL('../../../rust/core/tests/fixtures/step-page-directive.json', import.meta.url), 'utf8',
));

/** What a literal reads as: `''` un-doubled, then backslash escapes decoded. */
function decoded(literal: string): string {
  return decodeIfcString(literal.slice(1, -1).replace(/''/g, "'"));
}

function scan(ifc: string): { source: Uint8Array; refs: EntityRef[] } {
  const source = new TextEncoder().encode(ifc);
  const refs = Array.from(new StepTokenizer(source).scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  return { source, refs };
}

function file(name: string, description: string): string {
  return [
    '#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);',
    '#45=IFCAXIS2PLACEMENT3D($,$,$);',
    '#5=IFCLOCALPLACEMENT($,#45);',
    '#6=IFCPRODUCTDEFINITIONSHAPE($,$,$);',
    // Representation (#6) is attribute 6; a name with a comma and a `#9` in
    // its text must not shift it or be read as a reference.
    `#20=IFCWALL('0000000000000000000020',#1,${name},${description},$,#5,#6,$,$);`,
    `#21=IFCBEAM('0000000000000000000021',#1,${name},$,$,#5,$,$,$);`,
    "#10=IFCBUILDINGSTOREY('0000000000000000000010',#1,'Storey',$,$,#5,$,$,.ELEMENT.,$);",
    `#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000030',#1,${name},${description},(#20,#21),#10);`,
  ].join('\n');
}

async function parse(ifc: string) {
  const { source, refs } = scan(ifc);
  return new ColumnarParser().parseLite(source.buffer.slice(0) as ArrayBuffer, refs, {});
}

describe('columnar store reads records holding a PAGE apostrophe operand (#7589)', () => {
  it("decodes Name 'Para \\S\\' 5' and keeps later slots in place", async () => {
    const store = await parse(file("'Para \\S\\' 5'", "'Art \\S\\' 7, #9'"));
    expect(store.entities.getName(20)).toBe('Para § 5');
    expect(store.entities.getGlobalId(20)).toBe('0000000000000000000020');
    expect(store.entities.hasGeometry(20)).toBe(true);
    expect(store.entities.hasGeometry(21)).toBe(false);
    const contained = store.relationships!
      .getRelated(10, RelationshipType.ContainsElements, 'forward')
      .sort((a, b) => a - b);
    expect(contained).toEqual([20, 21]);
  });

  for (const { name, literal } of vectors) {
    it(`${name}: Name, hasGeometry and relationship refs survive the literal`, async () => {
      const store = await parse(file(literal, literal));
      expect(store.entities.getName(20)).toBe(decoded(literal));
      expect(store.entities.hasGeometry(20)).toBe(true);
      expect(store.entities.hasGeometry(21)).toBe(false);
      const contained = store.relationships!
        .getRelated(10, RelationshipType.ContainsElements, 'forward')
        .sort((a, b) => a - b);
      expect(contained).toEqual([20, 21]);
    });
  }
});

describe('EntityExtractor attributes around a PAGE apostrophe operand (#7589)', () => {
  function attributes(record: string): unknown[] {
    const { source, refs } = scan(record);
    return new EntityExtractor(source).extractEntity(refs[0])?.attributes ?? [];
  }

  it('decodes Name and Description and keeps the later references', () => {
    const attrs = attributes(
      "#20=IFCWALL('0000000000000000000020',#1,'Para \\S\\' 5','Art \\S\\' 7',$,#5,#6,$,$);",
    );
    expect(attrs).toEqual(['0000000000000000000020', 1, 'Para § 5', 'Art § 7', null, 5, 6, null, null]);
  });

  for (const { name, literal } of vectors) {
    it(`${name}: one value at top level and inside a list`, () => {
      const attrs = attributes(`#1=IFCX(${literal},(${literal},#7),#8);`);
      expect(attrs).toEqual([decoded(literal), [decoded(literal), 7], 8]);
    });
  }
});
