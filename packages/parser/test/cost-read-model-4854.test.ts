/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ColumnarParser } from '../src/columnar-parser.js';
import { evaluateCostItem, evaluateCostValue } from '../src/cost-evaluator.js';
import { extractCostOnDemand } from '../src/cost-extractor.js';
import { StepTokenizer } from '../src/tokenizer.js';

function step(schema: 'IFC4' | 'IFC4X3_ADD2' | 'IFC2X3', lines: string[]): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('cost.ifc','2026-01-01T00:00:00',('Author'),('Org'),'Exporter','ifc-lite test','');",
    `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

async function parse(text: string) {
  const bytes = new TextEncoder().encode(text);
  const tokenizer = new StepTokenizer(bytes);
  const refs = [...tokenizer.scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset,
    byteLength: ref.length, lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(bytes.buffer.slice(0), refs, {});
}

const IFC4_COST = step('IFC4', [
  "#1=IFCPROJECT('project',$,'Cost project',$,$,$,$,$,#2);",
  '#2=IFCUNITASSIGNMENT((#3,#4,#5));',
  '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#4=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
  "#5=IFCMONETARYUNIT('CHF');",
  "#6=IFCMONETARYUNIT('EUR');",
  '#7=IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.);',
  "#20=IFCWALL('wall',$,'Wall',$,$,$,$,$,$);",
  "#21=IFCTASK('task',$,'Install wall',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
  "#30=IFCQUANTITYAREA('Pricing area',$,$,24.,'measured');",
  "#31=IFCQUANTITYAREA('Product Qto area',$,$,999.,$);",
  "#34=IFCQUANTITYAREA('Pricing area mm2',$,#7,24000000.,$);",
  "#32=IFCELEMENTQUANTITY('qto',$,'Qto_WallBaseQuantities',$,$,(#31));",
  "#33=IFCRELDEFINESBYPROPERTIES('qto-rel',$,$,$,(#20),#32);",
  '#40=IFCMEASUREWITHUNIT(IFCAREAMEASURE(10.),#4);',
  '#41=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(5.),#5);',
  '#42=IFCMEASUREWITHUNIT(IFCMONETARYMEASURE(1.),#6);',
  '#43=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
  "#50=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(250.),#40,$,$,'LABOUR',$,$,$);",
  "#51=IFCCOSTVALUE('Adjustment',$,IFCMONETARYMEASURE(-50.),$,$,$,'LABOUR',$,$,$);",
  "#52=IFCCOSTVALUE('Tenth',$,IFCNUMERICMEASURE(0.1),$,$,$,$,$,$,$);",
  "#53=IFCCOSTVALUE('Two tenths',$,IFCNUMERICMEASURE(0.2),$,$,$,$,$,$,$);",
  "#54=IFCCOSTVALUE('Decimal sum',$,$,$,$,$,$,$,.ADD.,(#52,#53));",
  "#55=IFCCOSTVALUE('Explicit money',$,#41,$,$,$,$,$,$,$);",
  "#56=IFCCOSTVALUE('Zero',$,IFCNUMERICMEASURE(0.),$,$,$,$,$,$,$);",
  "#57=IFCCOSTVALUE('Bad divide',$,$,$,$,$,$,$,.DIVIDE.,(#52,#56));",
  "#58=IFCCOSTVALUE('Length rate',$,IFCMONETARYMEASURE(10.),#43,$,$,$,$,$,$);",
  "#90=IFCCOSTVALUE('Ten',$,IFCNUMERICMEASURE(10.),$,$,$,$,$,$,$);",
  "#91=IFCCOSTVALUE('Two',$,IFCNUMERICMEASURE(2.),$,$,$,$,$,$,$);",
  "#92=IFCCOSTVALUE('Subtract',$,$,$,$,$,$,$,.SUBTRACT.,(#90,#91));",
  "#93=IFCCOSTVALUE('Multiply',$,$,$,$,$,$,$,.MULTIPLY.,(#90,#91));",
  "#94=IFCCOSTVALUE('Divide',$,$,$,$,$,$,$,.DIVIDE.,(#90,#91));",
  "#95=IFCCOSTVALUE('Euro',$,#42,$,$,$,$,$,$,$);",
  "#96=IFCCOSTVALUE('Mixed',$,$,$,$,$,$,$,.ADD.,(#55,#95));",
  "#60=IFCCOSTITEM('root',$,'Root item','Root description','Pricing','CI-1',.USERDEFINED.,(#50,#51),(#30));",
  "#61=IFCCOSTITEM('child-a',$,'Child A',$,$,'CI-2',.NOTDEFINED.,(#54),$);",
  "#62=IFCCOSTITEM('child-b',$,'Child B',$,$,'CI-3',.NOTDEFINED.,(#50,#55),$);",
  "#63=IFCCOSTITEM('metric-equivalent',$,'Metric equivalent',$,$,'CI-4',.NOTDEFINED.,(#50),(#34));",
  "#64=IFCCOSTITEM('bad-basis',$,'Bad basis',$,$,'CI-5',.NOTDEFINED.,(#58),(#30));",
  "#70=IFCCOSTSCHEDULE('schedule',$,'Budget','Schedule description',$,'S-1',.BUDGET.,'DRAFT','2026-01-01','2026-02-01');",
  "#80=IFCRELASSIGNSTOCONTROL('schedule-items',$,$,$,(#60),$,#70);",
  "#81=IFCRELNESTS('nest',$,$,$,#60,(#61,#62));",
  "#82=IFCRELASSIGNSTOCONTROL('item-objects',$,$,$,(#20,#21),$,#60);",
  "#83=IFCRELASSIGNSTOPRODUCT('product-item',$,$,$,(#62),$,#20);",
  "#84=IFCRELASSIGNSTOPROCESS('task-product',$,$,$,(#20),$,#21,$);",
  "#85=IFCRELDECLARES('declares',$,$,$,#1,(#70));",
]);

describe('#4854 schema-aware cost graph', () => {
  it.each(['IFC4', 'IFC4X3_ADD2'] as const)('pins every %s IfcCostSchedule slot', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [
      "#70=IFCCOSTSCHEDULE('schedule',$,'Budget','Description','Object type','IDENT',.TENDER.,'STATUS','2026-03-04','2026-05-06');",
    ])));
    expect(extraction.CostSchedules[0]).toMatchObject({
      GlobalId: 'schedule', Name: 'Budget', Description: 'Description', ObjectType: 'Object type',
      Identification: 'IDENT', PredefinedType: 'TENDER', Status: 'STATUS',
      SubmittedOn: '2026-03-04', UpdateDate: '2026-05-06',
    });
  });

  it('preserves exact hierarchy, assignments, shared references, and CostQuantities only', async () => {
    const extraction = extractCostOnDemand(await parse(IFC4_COST));
    const root = extraction.CostItems.find(item => item.GlobalId === 'root');
    const childB = extraction.CostItems.find(item => item.GlobalId === 'child-b');

    expect(extraction.SchemaVersion).toBe('IFC4');
    expect(extraction.Currency).toBe('CHF');
    // #20 is the WALL (an IfcProduct), #21 the TASK bound through the same
    // IfcRelAssignsToControl (#82) — only the product belongs in
    // `productExpressIds` (#4877); the task assignment is still proven below
    // via the raw IfcRelAssignsToControl relationship record.
    expect(root).toMatchObject({
      Name: 'Root item', Description: 'Root description', Identification: 'CI-1',
      CostValues: [50, 51], CostQuantities: [30], childGlobalIds: ['child-a', 'child-b'],
      productExpressIds: [20],
    });
    expect(extraction.CostQuantities.map(quantity => quantity.expressId)).toEqual([30, 34]);
    expect(extraction.CostQuantities.some(quantity => quantity.AreaValue === '999')).toBe(false);
    expect(childB?.CostValues).toEqual([50, 55]);
    const rootSharedValue = root?.costValues?.[0];
    const childSharedValue = childB?.costValues?.[0];
    expect(rootSharedValue).toBeDefined();
    expect(childSharedValue).toBeDefined();
    expect(rootSharedValue).toBe(childSharedValue);

    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 81, Type: 'IfcRelNests', RelatingObject: 60, RelatedObjects: [61, 62] }),
      expect.objectContaining({ expressId: 82, Type: 'IfcRelAssignsToControl', RelatingControl: 60, RelatedObjects: [20, 21] }),
      expect.objectContaining({ expressId: 83, Type: 'IfcRelAssignsToProduct', RelatingProduct: 20, RelatedObjects: [62] }),
      expect.objectContaining({ expressId: 84, Type: 'IfcRelAssignsToProcess', RelatingProcess: 21, RelatedObjects: [20] }),
      expect.objectContaining({ expressId: 85, Type: 'IfcRelDeclares', RelatingContext: 1, RelatedDefinitions: [70] }),
    ]));
  });

  it('uses decimal arithmetic, currency, explicit money, UnitBasis, and diagnostics', async () => {
    const extraction = extractCostOnDemand(await parse(IFC4_COST));
    expect(evaluateCostItem(extraction, 60)).toMatchObject({ Amount: '-600', Currency: 'CHF', QuantityApplied: '24' });
    expect(evaluateCostItem(extraction, 63)).toMatchObject({ Amount: '600', Currency: 'CHF', QuantityApplied: '24' });
    expect(evaluateCostValue(extraction, 54)).toMatchObject({ Amount: '0.3', Diagnostics: [] });
    expect(evaluateCostValue(extraction, 55)).toMatchObject({ Amount: '5', Currency: 'CHF', Diagnostics: [] });
    expect(evaluateCostValue(extraction, 92).Amount).toBe('8');
    expect(evaluateCostValue(extraction, 93).Amount).toBe('20');
    expect(evaluateCostValue(extraction, 94).Amount).toBe('5');
    expect(evaluateCostValue(extraction, 57).Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'DIVISION_BY_ZERO' }),
    ]));
    expect(evaluateCostValue(extraction, 96).Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'MIXED_CURRENCY' }),
    ]));
    expect(evaluateCostItem(extraction, 64).Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' }),
    ]));
  });

  it('diagnoses malformed nesting and value cycles without discarding their edges', async () => {
    const malformed = step('IFC4', [
      "#10=IFCCOSTITEM('a',$,'A',$,$,'A',$,(#20),$);",
      "#11=IFCCOSTITEM('b',$,'B',$,$,'B',$,$,$);",
      "#12=IFCCOSTITEM('c',$,'C',$,$,'C',$,(#999),$);",
      "#20=IFCCOSTVALUE('Cycle',$,$,$,$,$,$,$,.ADD.,(#20));",
      "#30=IFCRELNESTS('ab',$,$,$,#10,(#11));",
      "#31=IFCRELNESTS('cb',$,$,$,#12,(#11));",
      "#32=IFCRELNESTS('ba',$,$,$,#11,(#10));",
    ]);
    const extraction = extractCostOnDemand(await parse(malformed));
    expect(extraction.Relationships.filter(rel => rel.Type === 'IfcRelNests')).toHaveLength(3);
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'MULTIPLE_NESTING_PARENTS', expressId: 11 }),
      expect.objectContaining({ Code: 'NESTING_CYCLE' }),
      expect.objectContaining({ Code: 'VALUE_CYCLE', expressId: 20 }),
      expect.objectContaining({ Code: 'MISSING_REFERENCE', RelatedExpressId: 999 }),
    ]));
  });

  it('keeps IFC2X3 metadata and legacy edges inspectable but refuses evaluation', async () => {
    const legacy = step('IFC2X3', [
      '#1=IFCCALENDARDATE(14,3,2011);',
      "#10=IFCCOSTITEM('legacy-item',$,'Legacy item',$,$);",
      "#20=IFCCOSTVALUE('Legacy value',$,IFCMONETARYMEASURE(10.),$,$,$,'LABOUR',$);",
      "#30=IFCCOSTSCHEDULE('legacy-schedule',$,'Legacy budget',$,$,$,$,#1,'DRAFT',$,#1,'CS-1',.BUDGET.);",
      "#40=IFCRELASSOCIATESAPPLIEDVALUE('value-rel',$,$,$,(#10),#20);",
      "#41=IFCRELSCHEDULESCOSTITEMS('schedule-rel',$,$,$,(#10),$,#30);",
      "#42=IFCAPPLIEDVALUERELATIONSHIP(#20,(#20),.ADD.,'legacy composition',$);",
    ]);
    const extraction = extractCostOnDemand(await parse(legacy));
    expect(extraction.CostSchedules[0]).toMatchObject({ ID: 'CS-1', Status: 'DRAFT', SubmittedOn: '2011-03-14' });
    expect(extraction.CostItems[0].CostValues).toBeUndefined();
    expect(extraction.Relationships.map(rel => rel.Type)).toEqual(expect.arrayContaining([
      'IfcRelAssociatesAppliedValue', 'IfcRelSchedulesCostItems', 'IfcAppliedValueRelationship',
    ]));
    const evaluation = evaluateCostValue(extraction, 20);
    expect(evaluation.Amount).toBeUndefined();
    expect(evaluation.Diagnostics[0]?.Code).toBe('IFC2X3_PARTIAL_READ');
  });
});
