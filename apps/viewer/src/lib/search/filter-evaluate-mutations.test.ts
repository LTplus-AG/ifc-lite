/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The evaluator's live-edit overlay (#4946 review finding on PR #4984),
 * isolated from the rest of `filter-evaluate.ts`: a `MutablePropertyView`
 * built for a server-hydrated store (no `setQuantityExtractor`, the
 * `hasQuantityBase() === false` case `element-field-families.ts` already
 * guards for, issue #2487) must not make an untouched quantity — or an
 * untouched quantity SET — vanish from what a rule reads just because a
 * sibling quantity was edited.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { quantitySetsFor } from './filter-evaluate-mutations.js';

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#5=IFCBUILDINGSTOREY('0Storey00000000000005',$,'Level 1',$,$,$,$,$,.ELEMENT.,0.);
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#120=IFCQUANTITYAREA('NetSideArea',$,$,10.,$);
#121=IFCQUANTITYLENGTH('Length',$,$,3.,$);
#122=IFCELEMENTQUANTITY('0Qto000000000000000122',$,'Qto_WallBaseQuantities',$,'BaseQuantities',(#120,#121));
#123=IFCRELDEFINESBYPROPERTIES('0Rel00000000000000123',$,$,$,(#41),#122);
ENDSEC;
END-ISO-10303-21;
`;

async function parsedStore() {
  const bytes = new TextEncoder().encode(MINI_IFC);
  return new IfcParser().parseColumnar(bytes.buffer);
}

describe('quantitySetsFor: a mutationView with no quantity base merges in the untouched quantities (#4946, issue #2487)', () => {
  it('editing one quantity keeps its sibling and the base is used as-is when a quantity extractor IS configured', async () => {
    const store = await parsedStore();
    const view = new MutablePropertyView(store.properties, 'm1');
    view.setOnDemandExtractor((id) => store.properties?.getForEntity(id) ?? []);
    view.setQuantityExtractor((id) => extractQuantitiesOnDemand(store, id));
    view.setQuantity(41, 'Qto_WallBaseQuantities', 'NetSideArea', 20);

    const sets = quantitySetsFor(store, 41, view);
    assert.equal(sets.length, 1);
    const names = sets[0].quantities.map((q) => q.name).sort();
    assert.deepEqual(names, ['Length', 'NetSideArea']);
    assert.equal(sets[0].quantities.find((q) => q.name === 'NetSideArea')?.value, 20, 'the edit applies');
    assert.equal(sets[0].quantities.find((q) => q.name === 'Length')?.value, 3, 'the untouched sibling is unaffected (extractor case)');
  });

  it('editing one quantity keeps its sibling and other quantity sets when NO quantity extractor is configured (server-hydrated store, issue #2487)', async () => {
    const store = await parsedStore();
    const view = new MutablePropertyView(store.properties, 'm1');
    // No setOnDemandExtractor / setQuantityExtractor — the base-table-only
    // construction a collab/server-hydrated view uses.
    assert.equal(view.hasQuantityBase(), false, 'no quantity extractor was configured');
    view.setQuantity(41, 'Qto_WallBaseQuantities', 'NetSideArea', 99);

    const withoutMutationView = quantitySetsFor(store, 41, undefined);
    assert.deepEqual(withoutMutationView.map((s) => s.name), ['Qto_WallBaseQuantities'], 'sanity: the base file has one quantity set');

    const sets = quantitySetsFor(store, 41, view);
    assert.equal(sets.length, 1, 'the quantity set survives — a bare overlay-only read would answer only the edited quantity');
    const names = sets[0].quantities.map((q) => q.name).sort();
    assert.deepEqual(names, ['Length', 'NetSideArea'], 'both quantities are present');
    assert.equal(sets[0].quantities.find((q) => q.name === 'NetSideArea')?.value, 99, 'the edit applies');
    assert.equal(sets[0].quantities.find((q) => q.name === 'Length')?.value, 3, 'the untouched sibling did not vanish');
  });
});
