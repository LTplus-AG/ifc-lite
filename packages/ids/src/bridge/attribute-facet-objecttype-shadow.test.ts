/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS `<attribute><name>ObjectType</name></attribute>` requirement,
 * checked against a REAL parsed store (not the mock accessor
 * `facets.test.ts` uses — that mock hands `ObjectType` to the checker
 * through a dedicated `objectType` field, so it cannot see a bug in how
 * the bridge POPULATES that value from the raw entity).
 *
 * `checkAttributeFacet`'s `getAttributeValue('objecttype', …)` reads
 * `accessor.getObjectType(expressId)`, which is `resolveObjectType` —
 * a helper built for the *PredefinedType* USERDEFINED-fallback lookup
 * (`matchPredefinedType`'s `userDefinedType` argument), documented in
 * `IFCDataAccessor.getObjectType` as "entity object type (predefined
 * type)". For an entity whose raw `PredefinedType` is a concrete,
 * non-`USERDEFINED`, non-`NOTDEFINED` enum token (e.g. `STANDARD`),
 * `resolveObjectType` returns that enum token immediately — it never
 * looks at the entity's actual `ObjectType` *attribute* at all. So an
 * IDS spec checking the real `ObjectType` attribute value on such an
 * entity is silently checked against the `PredefinedType` enum instead
 * — two distinct IFC attributes conflated into one, exactly the shape
 * `partof-predefined-type.test.ts` already pinned for `getAncestors`
 * (#2316) but here for the plain attribute-facet path.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import type { IDSAttributeFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

async function parse(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: EntityRef[] = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0) as ArrayBuffer, entityRefs, {});
}

// A wall with a concrete PredefinedType enum (STANDARD — not USERDEFINED,
// not NOTDEFINED) AND its own, unrelated ObjectType free-text value.
// Attribute order (IFC4 IfcWall): GlobalId, OwnerHistory, Name,
// Description, ObjectType, ObjectPlacement, Representation, Tag,
// PredefinedType.
const IFC = `#100=IFCWALL('0Wall00000000000000001',$,'Wall_001',$,'Steel I-Beam 200x100',$,$,$,.STANDARD.);`;

describe('IDS attribute facet — ObjectType must not read the PredefinedType enum', () => {
  it('reads the real ObjectType attribute, not the concrete PredefinedType token, for a required-and-present value check', async () => {
    const store = await parse(IFC);
    const accessor = createDataAccessor(store);

    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('ObjectType'),
      value: sv('Steel I-Beam 200x100'),
    };
    const result = checkAttributeFacet(facet, 100, accessor);

    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe('Steel I-Beam 200x100');
  });

  it('control: an unrelated required-and-present attribute (Name) still passes', async () => {
    const store = await parse(IFC);
    const accessor = createDataAccessor(store);

    const facet: IDSAttributeFacet = {
      type: 'attribute',
      name: sv('Name'),
      value: sv('Wall_001'),
    };
    const result = checkAttributeFacet(facet, 100, accessor);

    expect(result.passed).toBe(true);
  });
});
