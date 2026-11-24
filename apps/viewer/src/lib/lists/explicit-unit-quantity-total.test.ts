/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A quantity declaring its own `Unit` (mm2 in a square-metre project) must be
 * summed in the project's unit, not as a raw number. W1 has the same quantity
 * name in two Qto sets (first wins, 10), W2 is 5,000,000 mm2 = 5 m2, W3 inherits
 * 3 from its type, W4 overrides the type with 7. Expected total 25.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { createListDataProvider } from './adapter.js';
import { createProjectUnitListDataProvider } from './project-unit-quantities.js';

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,#90);
#90=IFCUNITASSIGNMENT((#91,#92));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#92=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#93=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);
#10=IFCWALL('Wall000000000000000001A',$,'W1',$,$,$,$,$,$);
#11=IFCWALL('Wall000000000000000002A',$,'W2',$,$,$,$,$,$);
#12=IFCWALL('Wall000000000000000003A',$,'W3',$,$,$,$,$,$);
#13=IFCWALL('Wall000000000000000004A',$,'W4',$,$,$,$,$,$);
#20=IFCQUANTITYAREA('NetSideArea',$,$,10.,$);
#21=IFCQUANTITYAREA('NetSideArea',$,$,10.,$);
#22=IFCELEMENTQUANTITY('Q000000000000000000A1',$,'Qto_WallBaseQuantities',$,$,(#20));
#23=IFCELEMENTQUANTITY('Q000000000000000000A2',$,'BaseQuantities',$,$,(#21));
#24=IFCRELDEFINESBYPROPERTIES('R000000000000000000A1',$,$,$,(#10),#22);
#25=IFCRELDEFINESBYPROPERTIES('R000000000000000000A2',$,$,$,(#10),#23);
#30=IFCQUANTITYAREA('NetSideArea',$,#93,5000000.,$);
#31=IFCELEMENTQUANTITY('Q000000000000000000B1',$,'Qto_WallBaseQuantities',$,$,(#30));
#32=IFCRELDEFINESBYPROPERTIES('R000000000000000000B1',$,$,$,(#11),#31);
#40=IFCQUANTITYAREA('NetSideArea',$,$,3.,$);
#41=IFCELEMENTQUANTITY('Q000000000000000000C1',$,'Qto_WallBaseQuantities',$,$,(#40));
#42=IFCWALLTYPE('WT00000000000000000001',$,'WT',$,$,(#41),$,$,$,.STANDARD.);
#43=IFCRELDEFINESBYTYPE('R000000000000000000C1',$,$,$,(#12,#13),#42);
#50=IFCQUANTITYAREA('NetSideArea',$,$,7.,$);
#51=IFCELEMENTQUANTITY('Q000000000000000000D1',$,'Qto_WallBaseQuantities',$,$,(#50));
#52=IFCRELDEFINESBYPROPERTIES('R000000000000000000D1',$,$,$,(#13),#51);
ENDSEC;
END-ISO-10303-21;
`;

describe('list quantity totals honour a member Unit', () => {
  it('sums an explicit-unit quantity in project units', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const provider = createProjectUnitListDataProvider(store);
    const def: ListDefinition = {
      id: 'l', name: 'n', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions: [], groups: [],
      columns: [
        { id: 'n', source: 'attribute', propertyName: 'Name' },
        { id: 'a', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' },
      ],
      grouping: { groupByColumnId: 'n', sumColumnIds: ['a'] },
    } as unknown as ListDefinition;
    const r = executeList(def, provider, 'm');
    assert.deepEqual(r.rows.map(x => x.values[1]), [10, 5, 3, 7]);
    assert.equal(r.summary?.sums.a, 25);
  });

  it('converts an overlay-edited quantity that keeps its own unit, and the plain provider keeps the scale', async () => {
    const bytes = new TextEncoder().encode(STEP);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(store.properties, 'm');
    view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
    // W2's own unit is mm2: an edit to 7,000,000 stays in mm2 (7 m2).
    view.setQuantity(11, 'Qto_WallBaseQuantities', 'NetSideArea', 7_000_000, QuantityType.Area);
    const plain = createListDataProvider(store, '', undefined, view);
    const edited = plain.getQuantitySets(11).flatMap(set => set.quantities).find(q => q.name === 'NetSideArea');
    assert.equal(edited?.value, 7_000_000, 'the plain provider (charts) does not convert');
    const unedited = createListDataProvider(store).getQuantitySets(11)[0].quantities[0] as { explicitUnitSiScale?: number };
    assert.equal(unedited.explicitUnitSiScale, 1e-6, 'the plain provider keeps the explicit unit scale');
    const provider = createProjectUnitListDataProvider(store, '', undefined, view);
    const converted = provider.getQuantitySets(11).flatMap(set => set.quantities).find(q => q.name === 'NetSideArea');
    assert.equal(converted?.value, 7);
  });
});
