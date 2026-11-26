/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A quantity declaring its own `Unit` (mm2 in a square-metre project) must be
 * summed in the project's unit, not as a raw number (#11469). W1 has the same
 * quantity name in two sets and the column reads the Qto_WallBaseQuantities one
 * (10, not BaseQuantities' 99). W2 is 5,000,000 mm2 = 5 m2, W3 inherits 3 from
 * its type, W4 overrides the type with 7. Expected total 25.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { IfcTypeEnum, QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createListDataProvider } from './adapter.js';
import { createProjectUnitListDataProvider } from './project-unit-quantities.js';
import { resolveBinding } from '../document/bindings.js';

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
#21=IFCQUANTITYAREA('NetSideArea',$,$,99.,$);
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

  for (const [description, unit, sourceValue, scale] of [
    ['explicit project unit', 92, 1.0000000000006, 1],
    ['square millimetres', 93, 1000000.0000006, 1e-6],
  ] as const) {
    it(`preserves list cells and sums for a high-precision quantity in ${description} (#11469)`, async () => {
      const source = STEP.replace(
        "#30=IFCQUANTITYAREA('NetSideArea',$,#93,5000000.,$);",
        `#30=IFCQUANTITYAREA('NetSideArea',$,#${unit},${sourceValue},$);`,
      );
      const bytes = new TextEncoder().encode(source);
      const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
      const definition: ListDefinition = {
        id: 'precision', name: 'Area precision', createdAt: 0, updatedAt: 0,
        entityTypes: [IfcTypeEnum.IfcWall], expressIdsByModel: { m: [11] }, groups: [],
        columns: [
          { id: 'n', source: 'attribute', propertyName: 'Name' },
          { id: 'a', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetSideArea' },
        ],
        grouping: { columnId: 'n', sumColumnIds: ['a'] },
      };
      const result = executeList(definition, createProjectUnitListDataProvider(store), 'm');
      assert.equal(result.rows[0].values[1], sourceValue * scale);
      assert.equal(result.summary?.sums.a, sourceValue * scale);
    });
  }

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

  // #11469: mass and time follow the project's own unit (tonne, minute), not SI.
  const MASS_TIME = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,#90);
#90=IFCUNITASSIGNMENT((#91,#95,#98));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#94=IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.);
#95=IFCCONVERSIONBASEDUNIT(#96,.MASSUNIT.,'tonne',#97);
#96=IFCDIMENSIONALEXPONENTS(0,1,0,0,0,0,0);
#97=IFCMEASUREWITHUNIT(IFCMASSMEASURE(1000.),#94);
#100=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);
#98=IFCCONVERSIONBASEDUNIT(#99,.TIMEUNIT.,'minute',#101);
#99=IFCDIMENSIONALEXPONENTS(0,0,1,0,0,0,0);
#101=IFCMEASUREWITHUNIT(IFCTIMEMEASURE(60.),#100);
#10=IFCWALL('Wall000000000000000001A',$,'W1',$,$,$,$,$,$);
#11=IFCWALL('Wall000000000000000002A',$,'W2',$,$,$,$,$,$);
#20=IFCQUANTITYWEIGHT('GrossWeight',$,#94,500.,$);
#21=IFCQUANTITYTIME('Duration',$,#100,120.,$);
#22=IFCELEMENTQUANTITY('Q000000000000000000A1',$,'Qto_WallBaseQuantities',$,$,(#20,#21));
#23=IFCRELDEFINESBYPROPERTIES('R000000000000000000A1',$,$,$,(#10),#22);
#30=IFCQUANTITYWEIGHT('GrossWeight',$,$,1.5,$);
#31=IFCQUANTITYTIME('Duration',$,$,3.,$);
#32=IFCELEMENTQUANTITY('Q000000000000000000B1',$,'Qto_WallBaseQuantities',$,$,(#30,#31));
#33=IFCRELDEFINESBYPROPERTIES('R000000000000000000B1',$,$,$,(#11),#32);
ENDSEC;
END-ISO-10303-21;
`;

  it('expresses and sums mass and time in a tonne and minute project', async () => {
    const bytes = new TextEncoder().encode(MASS_TIME);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const def: ListDefinition = {
      id: 'l', name: 'n', createdAt: 0, updatedAt: 0, entityTypes: [IfcTypeEnum.IfcWall], conditions: [], groups: [],
      columns: [
        { id: 'n', source: 'attribute', propertyName: 'Name' },
        { id: 'w', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'GrossWeight' },
        { id: 't', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Duration' },
      ],
      grouping: { groupByColumnId: 'n', sumColumnIds: ['w', 't'] },
    } as unknown as ListDefinition;
    const r = executeList(def, createProjectUnitListDataProvider(store), 'm');
    assert.deepEqual(r.rows.map(x => [x.values[1], x.values[2]]), [[0.5, 2], [1.5, 3]]);
    assert.equal(r.summary?.sums.w, 2);
    assert.equal(r.summary?.sums.t, 5);
  });

  it('reports a document field on a quantity whose own Unit does not resolve, instead of printing NaN', async () => {
    // An area quantity whose Unit is a length unit: the collector marks it unresolved.
    const source = STEP.replace("#30=IFCQUANTITYAREA('NetSideArea',$,#93,5000000.,$);", "#30=IFCQUANTITYAREA('NetSideArea',$,#91,5000000.,$);");
    const bytes = new TextEncoder().encode(source);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const r = resolveBinding('Element[Wall000000000000000002A].Qto_WallBaseQuantities.NetSideArea', {
      models: [{ id: 'm', name: 'm.ifc', store }], activeModelId: 'm', today: new Date(2026, 10, 26),
    });
    assert.equal(r.ok, false);
    assert.notEqual(r.value, 'NaN');
  });
});
