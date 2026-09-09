/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { getInheritanceChain } from '../src/ifc-schema.js';

// `columnar-entity-preparation.ts`'s `getCategory()` retains a fixed list of
// 22 non-product helper entity names (`RELEVANT_NON_PRODUCT_HELPERS`) even
// though they are not IfcRoot descendants — on-demand extraction and
// StepExporter need them addressable in `byId` (findPreferredGeometric
// RepresentationContextId(), findLengthUnitReference(), material/
// classification/document resolution). Nothing in the existing suite drives
// `prepareColumnarEntities`/`parseLite` over one of these types and checks
// it survives: removing `RELEVANT_NON_PRODUCT_HELPERS.has(upper)` from the
// retention condition leaves the full suite green.
//
// Pick a handful of representative helpers spanning different branches of
// the list (a unit, a material, a classification, a document) and confirm,
// against the real generated schema data
// (packages/data/src/ifc-schema/generated/entities-ifc4.ts), that none of
// them is an IfcRoot descendant — so their retention can ONLY be explained
// by the `RELEVANT_NON_PRODUCT_HELPERS` clause, not by
// `isSubtypeOfAny(upper, ROOT_TYPES)` or the `IFCREL` lexical fallback.
describe('#4204 — RELEVANT_NON_PRODUCT_HELPERS entries are not IfcRoot descendants per the schema', () => {
  it.each(['IfcSIUnit', 'IfcUnitAssignment', 'IfcMaterial', 'IfcClassification', 'IfcDocumentInformation'])(
    '%s does not inherit from IfcRoot and is not named IfcRel*',
    (type) => {
      expect(type.toUpperCase().startsWith('IFCREL')).toBe(false);
      const chain = getInheritanceChain(type).map((c) => c.toUpperCase());
      expect(chain).not.toContain('IFCROOT');
    }
  );
});

// Neutral synthetic fixture: one instance each of a representative helper
// entity, none of which is an IfcProduct, IfcGroup, IfcRoot descendant, or
// "IfcRel*"-named — so if `RELEVANT_NON_PRODUCT_HELPERS.has(upper)` is
// dropped from the retention condition, every one of these falls to
// CAT_SKIP and becomes unaddressable.
const IFC = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#30=IFCSIUNIT($,.LENGTHUNIT.,$,.METRE.);
#31=IFCUNITASSIGNMENT((#30));
#32=IFCMATERIAL('Concrete',$,$);
#33=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#34=IFCDOCUMENTINFORMATION('DocId001','Spec Document',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);`;

async function parse() {
  const source = new TextEncoder().encode(IFC);
  const tokenizer = new StepTokenizer(source);
  const entityRefs = Array.from(tokenizer.scanEntitiesFast()).map((ref) => ({
    expressId: ref.expressId,
    type: ref.type,
    byteOffset: ref.offset,
    byteLength: ref.length,
    lineNumber: ref.line,
  }));
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {});
}

describe('#4204 — the parser retains RELEVANT_NON_PRODUCT_HELPERS entities in the EntityTable', () => {
  it('resolves the exact type name for each helper, instead of "Unknown"', async () => {
    const store = await parse();
    expect(store.entities.getTypeName(30)).toBe('IfcSIUnit');
    expect(store.entities.getTypeName(31)).toBe('IfcUnitAssignment');
    expect(store.entities.getTypeName(32)).toBe('IfcMaterial');
    expect(store.entities.getTypeName(33)).toBe('IfcClassification');
    expect(store.entities.getTypeName(34)).toBe('IfcDocumentInformation');
  });
});
