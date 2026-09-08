/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS partOf facet's nested `predefinedType` constraint, checked against a
 * REAL parsed store (not the mock accessor `facets.test.ts` uses — that
 * mock hands `ParentInfo.predefinedType` to the checker directly, so it
 * cannot see a bug in how the bridge POPULATES that field).
 *
 * `getAncestors` sourced `ParentInfo.predefinedType` from
 * `accessor.getObjectType(parentId)` instead of
 * `accessor.getPredefinedTypeRaw(parentId)`. For a parent whose raw
 * `PredefinedType` is `USERDEFINED` with an accompanying user-defined name
 * (e.g. `ObjectType = 'CustomWallType'`), `getObjectType` returns the name,
 * not the literal token `USERDEFINED` — so an IDS spec asking for the
 * literal enum token `USERDEFINED` (a value `checkEntityFacet`/
 * `entityFacetPasses` both accept for the very same entity, see
 * `entity-facet.ts`'s two-branch match) silently FAILED for `partOf`.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer, ColumnarParser } from '@ifc-lite/parser';
import type { EntityRef } from '@ifc-lite/parser';
import { createDataAccessor } from './data-accessor.js';
import { checkPartOfFacet } from '../facets/partof-facet.js';
import type { IDSPartOfFacet, IDSSimpleValue } from '../types.js';

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

// Child wall #100 aggregated into parent wall #200. Parent's raw
// PredefinedType is USERDEFINED with a custom name in ObjectType — the
// same shape `entity-facet.ts` handles with its rawType/userDefinedType
// two-branch match.
const IFC = `#100=IFCWALL('0Wall00000000000000001',$,'Child',$,$,$,$,$,$);
#200=IFCWALL('0Wall00000000000000002',$,'Parent',$,'CustomWallType',$,$,$,.USERDEFINED.);
#300=IFCRELAGGREGATES('0RelAgg000000000000001',$,$,$,#200,(#100));`;

describe('IDS partOf predefinedType — sourced from the raw enum, not ObjectType', () => {
  it('matches the literal USERDEFINED token against a parent whose raw PredefinedType is USERDEFINED (even though it also carries a custom name)', async () => {
    const store = await parse(IFC);
    const accessor = createDataAccessor(store);
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
      entity: { type: 'entity', name: sv('IFCWALL'), predefinedType: sv('USERDEFINED') },
    };
    const result = checkPartOfFacet(facet, 100, accessor);
    expect(result.passed).toBe(true);
  });

  it('still matches the user-defined name as a fallback for the same parent', async () => {
    const store = await parse(IFC);
    const accessor = createDataAccessor(store);
    const facet: IDSPartOfFacet = {
      type: 'partOf',
      relation: 'IfcRelAggregates',
      entity: { type: 'entity', name: sv('IFCWALL'), predefinedType: sv('CustomWallType') },
    };
    const result = checkPartOfFacet(facet, 100, accessor);
    expect(result.passed).toBe(true);
  });
});
