/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ColumnarParser } from '../src/columnar-parser.js';
import { evaluateCostItem, evaluateCostValue } from '../src/cost-evaluator.js';
import { extractCostOnDemand } from '../src/cost-extractor.js';
import { costReferenceLexeme, withoutStepComments } from '../src/cost-step-lexemes.js';
import type {
  CostDiagnostic, CostGraphExtraction, CostMeasureWithUnitInfo, CostQuantityInfo, CostValueInfo,
} from '../src/cost-types.js';
import type { IfcSourceBytes } from '../src/source-bytes.js';
import { StepTokenizer } from '../src/tokenizer.js';

class CountingSource implements IfcSourceBytes {
  readonly counts = new Map<string, number>();
  constructor(private readonly source: IfcSourceBytes) {}
  get byteLength(): number { return this.source.byteLength; }
  get length(): number { return this.source.length; }
  get isResident(): boolean { return this.source.isResident; }
  get contentKey(): string | null { return this.source.contentKey; }
  slice(start: number, end: number): Uint8Array { return this.source.slice(start, end); }
  decodeUtf8(start: number, end: number): string {
    const key = `${start}:${end}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return this.source.decodeUtf8(start, end);
  }
  materialize(): Uint8Array { return this.source.materialize(); }
  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T { return this.source.withMaterialized(fn); }
  withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    return this.source.withMaterializedAsync(fn);
  }
  toTransferable(): ReturnType<IfcSourceBytes['toTransferable']> { return this.source.toTransferable(); }
}

function step(schema: string, lines: string[]): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    "FILE_NAME('cost.ifc','2026-01-01T00:00:00',('Author'),('Org'),'Exporter','cost regression','');",
    `FILE_SCHEMA(('${schema}'));`, 'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

async function parse(text: string) {
  const bytes = new TextEncoder().encode(text);
  const refs = [...new StepTokenizer(bytes).scanEntitiesFast()].map(ref => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset,
    byteLength: ref.length, lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(bytes.buffer.slice(0), refs, {});
}

const PROJECT = [
  "#1=IFCPROJECT('project',$,'Cost project',$,$,$,$,$,#2);",
  '#2=IFCUNITASSIGNMENT((#3,#4,#5,#6,#7));',
  '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#4=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
  "#5=IFCMONETARYUNIT('CHF');",
  '#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '#7=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);',
];

function valueGraph(CostValues: CostValueInfo[]): CostGraphExtraction {
  return {
    SchemaVersion: 'IFC4', CostSchedules: [], CostItems: [], CostValues,
    CostQuantities: [], Units: [], MeasuresWithUnit: [], ProjectUnits: {},
    Relationships: [], Diagnostics: [], HasCostData: true,
    costSchedules: [], costItems: [], hasCost: true,
  };
}

describe('#4854 cost evaluator blocker regressions', () => {
  it.each([0, 1.5, 1_000_000_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid evaluation Precision %s without throwing', async (Precision) => {
      const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
        "#10=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
        "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
      ])));
      expect(() => evaluateCostValue(extraction, 10, { Precision })).not.toThrow();
      expect(evaluateCostValue(extraction, 10, { Precision })).toMatchObject({
        Amount: undefined,
        Diagnostics: [expect.objectContaining({ Code: 'INVALID_NUMBER', Severity: 'error' })],
      });
      expect(evaluateCostItem(extraction, 20, { Precision })).toMatchObject({
        Amount: undefined,
        Diagnostics: [expect.objectContaining({ Code: 'INVALID_NUMBER', Severity: 'error' })],
      });
    },
  );

  it('reproduces the buildingSMART canonical cost-composition record', async () => {
    // IFC4 IfcCostItem Figure 3: scaffolding 100 m² × (5 + 3) = 800,
    // brickwork 100 m³ × (10 + 3) = 1300, wildcard subtotal = 2100.
    // https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2/HTML/link/ifccostitem.htm
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYAREA('Scaffolding area',$,$,100.,$);",
      "#11=IFCQUANTITYVOLUME('Brick volume',$,$,100.,$);",
      '#15=IFCMEASUREWITHUNIT(IFCAREAMEASURE(10.),#4);',
      '#16=IFCMEASUREWITHUNIT(IFCVOLUMEMEASURE(10.),#7);',
      "#20=IFCCOSTVALUE('Scaffold material',$,IFCMONETARYMEASURE(50.),#15,$,$,'Material',$,$,$);",
      "#21=IFCCOSTVALUE('Scaffold labour',$,IFCMONETARYMEASURE(30.),#15,$,$,'Labor',$,$,$);",
      "#22=IFCCOSTVALUE('Brick material',$,IFCMONETARYMEASURE(100.),#16,$,$,'Material',$,$,$);",
      "#23=IFCCOSTVALUE('Brick labour',$,IFCMONETARYMEASURE(30.),#16,$,$,'Labor',$,$,$);",
      "#24=IFCCOSTVALUE('Subtotal',$,$,$,$,$,'*',$,$,$);",
      "#25=IFCCOSTVALUE('Material subtotal',$,$,$,$,$,'Material',$,$,$);",
      "#26=IFCCOSTVALUE('Conditional',$,IFCMONETARYMEASURE(100.),$,$,$,$,'requires context',$,$);",
      "#30=IFCCOSTITEM('scaffold',$,'Scaffolding',$,$,'S',$,(#20,#21),(#10));",
      "#31=IFCCOSTITEM('brick',$,'Brick wall',$,$,'B',$,(#22,#23),(#11));",
      "#32=IFCCOSTITEM('subtotal',$,'Subtotal',$,$,'T',$,(#24),$);",
      "#33=IFCCOSTITEM('scaffold-material',$,'Scaffolding material',$,$,'SM',$,(#20,#21),(#10));",
      "#34=IFCCOSTITEM('brick-material',$,'Brick material',$,$,'BM',$,(#22,#23),(#11));",
      "#35=IFCCOSTITEM('material-total',$,'Material total',$,$,'MT',$,(#25),$);",
      "#36=IFCCOSTITEM('conditional',$,'Conditional',$,$,'COND',$,(#26),$);",
      "#40=IFCRELNESTS('subtotal-items',$,$,$,#32,(#30,#31));",
      "#41=IFCRELNESTS('material-items',$,$,$,#35,(#33,#34));",
    ])));
    expect(evaluateCostItem(extraction, 30).Amount).toBe('800');
    expect(evaluateCostItem(extraction, 31).Amount).toBe('1300');
    expect(evaluateCostItem(extraction, 32)).toMatchObject({ Amount: '2100', Currency: 'CHF' });
    expect(evaluateCostItem(extraction, 35)).toMatchObject({ Amount: '1500', Currency: 'CHF' });
    expect(evaluateCostItem(extraction, 36)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'UNSUPPORTED_CONDITION' })]),
    });
  });

  it('includes uncategorized nested costs in named category subtotals', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Uncategorized',$,IFCMONETARYMEASURE(100.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Labour',$,IFCMONETARYMEASURE(50.),$,$,$,'LABOUR',$,$,$);",
      "#12=IFCCOSTVALUE('Labour subtotal',$,$,$,$,$,'LABOUR',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10,#11),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#12),$);",
      "#30=IFCRELNESTS('nest',$,$,$,#21,(#20));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: '150', Currency: 'CHF', Diagnostics: [],
    });
  });

  it('withholds named subtotals when a child mixes uncategorized cost with an invalid category', async () => {
    const repeated = Array.from({ length: 99_997 }, () => '#11').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Uncategorized',$,IFCMONETARYMEASURE(100.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Labour leaf',$,IFCMONETARYMEASURE(1.),$,$,$,'LABOUR',$,$,$);",
      `#12=IFCCOSTVALUE('Invalid labour',$,$,$,$,$,'LABOUR',$,.ADD.,(${repeated}));`,
      "#13=IFCCOSTVALUE('Labour subtotal',$,$,$,$,$,'LABOUR',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10,#12),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#13),$);",
      "#30=IFCRELNESTS('nest',$,$,$,#21,(#20));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_LIST' })]),
    });
  }, 10_000);

  it('reads cost attributes after a comment containing structural characters', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE/* ( , ' /* nested opener is text */('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM/* ) , ' ( */('item',$,'Item',$,$,'I',$,(#10),$);",
    ])));
    expect(extraction.CostValues[0]).toMatchObject({
      expressId: 10, Name: 'Value', AppliedValue: { Kind: 'Typed', Value: '10.' },
    });
    expect(evaluateCostItem(extraction, 20)).toMatchObject({
      Amount: '10', Currency: 'CHF', Diagnostics: [],
    });
  });

  it('multiplies unit costs by direct CostQuantities even without UnitBasis', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYCOUNT('Count',$,$,3.,$);",
      "#20=IFCCOSTVALUE('Unit cost',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({ Amount: '30', Currency: 'CHF', QuantityApplied: '3' });
  });

  it('prices implicit rates in the project quantity unit rather than canonical SI', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Cost project',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      "#4=IFCMONETARYUNIT('CHF');",
      "#10=IFCQUANTITYLENGTH('Length',$,$,1000.,$);",
      "#20=IFCCOSTVALUE('Per millimetre',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({ Amount: '2000', QuantityApplied: '1000' });
  });

  it('aggregates wildcard and named categories from nested items', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Labour',$,IFCMONETARYMEASURE(10.),$,$,$,'LABOUR',$,$,$);",
      "#11=IFCCOSTVALUE('Material',$,IFCMONETARYMEASURE(20.),$,$,$,'MATERIAL',$,$,$);",
      "#12=IFCCOSTVALUE('All',$,$,$,$,$,'*',$,$,$);",
      "#13=IFCCOSTVALUE('Labour total',$,$,$,$,$,'LABOUR',$,$,$);",
      "#20=IFCCOSTITEM('child-a',$,'A',$,$,'A',$,(#10),$);",
      "#21=IFCCOSTITEM('child-b',$,'B',$,$,'B',$,(#11),$);",
      "#22=IFCCOSTITEM('all',$,'All',$,$,'ALL',$,(#12),$);",
      "#23=IFCCOSTITEM('labour',$,'Labour',$,$,'LAB',$,(#13),$);",
      "#24=IFCCOSTITEM('labour-child',$,'Labour child',$,$,'LC',$,(#10),$);",
      "#30=IFCRELNESTS('all-nest',$,$,$,#22,(#20,#21));",
      "#31=IFCRELNESTS('lab-nest',$,$,$,#23,(#24));",
    ])));
    expect(evaluateCostItem(extraction, 22)).toMatchObject({ Amount: '30', Currency: 'CHF' });
    expect(evaluateCostItem(extraction, 23)).toMatchObject({ Amount: '10', Currency: 'CHF' });
  });

  it('does not double-count a nested wildcard subtotal', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Material',$,IFCMONETARYMEASURE(10.),$,$,$,'Material',$,$,$);",
      "#11=IFCCOSTVALUE('Middle subtotal',$,$,$,$,$,'*',$,$,$);",
      "#12=IFCCOSTVALUE('Root subtotal',$,$,$,$,$,'*',$,$,$);",
      "#20=IFCCOSTITEM('leaf',$,'Leaf',$,$,'L',$,(#10),$);",
      "#21=IFCCOSTITEM('middle',$,'Middle',$,$,'M',$,(#11),$);",
      "#22=IFCCOSTITEM('root',$,'Root',$,$,'R',$,(#12),$);",
      "#30=IFCRELNESTS('middle-leaf',$,$,$,#21,(#20));",
      "#31=IFCRELNESTS('root-middle',$,$,$,#22,(#21));",
    ])));
    expect(extraction.Diagnostics).toEqual([]);
    expect(evaluateCostItem(extraction, 20).Amount).toBe('10');
    expect(evaluateCostItem(extraction, 21).Amount).toBe('10');
    expect(evaluateCostItem(extraction, 22).Amount).toBe('10');
  });

  it('uses a named category subtotal as an arithmetic operand', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Material',$,IFCMONETARYMEASURE(20800.),$,$,$,'Material',$,$,$);",
      "#11=IFCCOSTVALUE('Material subtotal',$,$,$,$,$,'Material',$,$,$);",
      "#12=IFCCOSTVALUE('Tax rate',$,IFCRATIOMEASURE(.1),$,$,$,$,$,$,$);",
      "#13=IFCCOSTVALUE('Tax',$,$,$,$,$,'Tax',$,.MULTIPLY.,(#11,#12));",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('tax',$,'Tax',$,$,'T',$,(#13),$);",
      "#30=IFCRELNESTS('nest',$,$,$,#21,(#20));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({ Amount: '2080', Currency: 'CHF' });
  });

  it('preserves exact decimal lexemes and rejects non-finite values', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Integer',$,IFCNUMERICMEASURE(9007199254740993.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Decimal',$,IFCNUMERICMEASURE(0.1234567890123456789012345678901234),$,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('NaN',$,IFCNUMERICMEASURE('NaN'),$,$,$,$,$,$,$);",
      "#13=IFCCOSTVALUE('Infinity',$,IFCNUMERICMEASURE(1E9999999),$,$,$,$,$,$,$);",
    ])));
    expect(extraction.CostValues.find(value => value.expressId === 10)?.AppliedValue).toMatchObject({ Value: '9007199254740993.' });
    expect(evaluateCostValue(extraction, 10).Amount).toBe('9007199254740993');
    expect(evaluateCostValue(extraction, 11).Amount).toBe('0.1234567890123456789012345678901234');
    for (const id of [12, 13]) {
      expect(evaluateCostValue(extraction, id)).toMatchObject({
        Amount: undefined, Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
      });
    }
  });

  it('preserves exact decimal lexemes surrounded by STEP comments', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#10=IFCCOSTVALUE('Commented',$,IFCNUMERICMEASURE(/* before */0.1234567890123456789012345678901234/* after */),$,$,$,$,$,$,$);",
    ])));
    expect(evaluateCostValue(extraction, 10).Amount).toBe('0.1234567890123456789012345678901234');
  });

  it('decodes each shared cost entity source record once per extraction', async () => {
    const store = await parse(step('IFC4', [
      "#20=IFCCOSTVALUE('Shared',$,IFCNUMERICMEASURE(1.25),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('a',$,'A',$,$,'A',$,(#20),$);",
      "#31=IFCCOSTITEM('b',$,'B',$,$,'B',$,(#20),$);",
    ]));
    const source = new CountingSource(store.source);
    store.source = source;
    const ref = store.entityIndex.byId.get(20);
    expect(ref).toBeDefined();
    extractCostOnDemand(store);
    expect(source.counts.get(`${ref?.byteOffset}:${(ref?.byteOffset ?? 0) + (ref?.byteLength ?? 0)}`)).toBe(1);
  });

  it('applies a composed UnitBasis rate quantity exactly once', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYAREA('Area',$,$,3.,$);",
      '#11=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#4);',
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),#11,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Composition',$,$,$,$,$,$,$,.ADD.,(#20));",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#21),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({ Amount: '30', QuantityApplied: '3' });
  });

  it('normalizes explicit and implicit component rates before extending the expression', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYAREA('Area',$,$,3.,$);",
      '#11=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#4);',
      "#20=IFCCOSTVALUE('Explicit rate',$,IFCMONETARYMEASURE(10.),#11,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Implicit rate',$,IFCMONETARYMEASURE(5.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Mixed composition',$,$,$,$,$,$,$,.ADD.,(#20,#21));",
      "#30=IFCCOSTITEM('mixed',$,'Mixed',$,$,'M',$,(#22),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30).Amount).toBe('45');
  });

  it('rejects every incompatible quantity instead of pricing a matching subset', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYAREA('Area',$,$,2.,$);",
      "#11=IFCQUANTITYLENGTH('Length',$,$,99.,$);",
      '#12=IFCMEASUREWITHUNIT(IFCAREAMEASURE(1.),#4);',
      "#20=IFCCOSTVALUE('Area rate',$,IFCMONETARYMEASURE(10.),#12,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10,#11));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it('normalizes mixed explicit quantity units before applying an implicit rate', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      "#10=IFCQUANTITYLENGTH('Metre',$,$,1.,$);",
      "#11=IFCQUANTITYLENGTH('Millimetres',$,#5,1000.,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10,#11));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({ Amount: '20', QuantityApplied: '2' });
  });

  it('normalizes compatible measure-with-unit operands and rejects inverse money', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1000.),#6);',
      '#11=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('mm',$,#10,$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('m',$,#11,$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('sum',$,$,$,$,$,$,$,.ADD.,(#20,#21));",
      "#23=IFCCOSTVALUE('ratio',$,IFCRATIOMEASURE(2.),$,$,$,$,$,$,$);",
      "#24=IFCCOSTVALUE('money',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#25=IFCCOSTVALUE('inverse',$,$,$,$,$,$,$,.DIVIDE.,(#23,#24));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({ Amount: '2', Dimension: 'length', Diagnostics: [] });
    expect(evaluateCostValue(extraction, 25)).toMatchObject({
      Amount: undefined, Currency: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('rejects inverse quantity dimensions in %s division', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Money',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Inverse',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('rejects derived inverse dimensions in %s division', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('Area per length',$,IFCAREAMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Area',$,IFCAREAMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Inverse length',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it('rejects inverse cost-rate division without a project currency', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'No currency',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Money',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Inverse',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it('multiplies a currency-less monetary rate by its matching quantity', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'No currency',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Length',$,IFCLENGTHMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Product',$,$,$,$,$,$,$,.MULTIPLY.,(#20,#21));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: '20', Currency: undefined, Dimension: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_CURRENCY' })]),
    });
    expect(evaluateCostValue(extraction, 22).Diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' }),
    ]));
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('derives a monetary rate when %s money is divided by length', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [
      "#1=IFCPROJECT('project',$,'Rates',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      "#20=IFCCOSTVALUE('Money',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Length',$,IFCLENGTHMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Rate',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: '5', Currency: 'GBP', Dimension: 'length', Diagnostics: [],
    });
  });

  it('accepts the Part 21 #0 entity-instance name but rejects leading-zero references', () => {
    expect(costReferenceLexeme('#0')).toBe(0);
    expect(costReferenceLexeme('#00')).toBeUndefined();
    expect(costReferenceLexeme('#01')).toBeUndefined();
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('retains an %s product assignment to cost item #0', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [
      "#0=IFCCOSTITEM('item',$,'Item',$,$,'I',$,$,$);",
      "#21=IFCWALLTYPE('type',$,'Type',$,$,$,$,$,$,.STANDARD.);",
      "#30=IFCRELASSIGNSTOPRODUCT('assignment',$,$,$,(#0),$,#21);",
    ])));
    expect(extraction.CostItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 0 }),
    ]));
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        expressId: 30, Type: 'IfcRelAssignsToProduct', RelatedObjects: [0],
        RelatingProduct: 21, InvalidReferences: undefined,
      }),
    ]));
  });

  it('removes comments linearly without treating comment delimiters in strings as trivia', () => {
    const unterminatedOpeners = '/*x'.repeat(40_000);
    expect(withoutStepComments(`'literal /* retained */' /* removed */ #3`))
      .toBe("'literal /* retained */'   #3");
    expect(withoutStepComments(unterminatedOpeners)).toBe(unterminatedOpeners);
  }, 1_000);

  it('propagates a nesting cycle failure through every evaluated ancestor', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('A value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('B value',$,IFCMONETARYMEASURE(20.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('a',$,'A',$,$,'A',$,(#10),$);",
      "#21=IFCCOSTITEM('b',$,'B',$,$,'B',$,(#11),$);",
      "#30=IFCRELNESTS('a-b',$,$,$,#20,(#21));",
      "#31=IFCRELNESTS('b-a',$,$,$,#21,(#20));",
    ])));
    for (const expressId of [20, 21]) {
      expect(evaluateCostItem(extraction, expressId)).toMatchObject({
        Amount: undefined,
        Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'NESTING_CYCLE' })]),
      });
    }
  });

  it('rejects non-IfcPhysicalQuantity references without inserting malformed quantity nodes', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),(#40));",
      "#40=IFCTASK('task',$,'Not a quantity',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
    ])));
    expect(extraction.CostQuantities.some(quantity => quantity.expressId === 40)).toBe(false);
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 40 }),
    ]));
    expect(evaluateCostItem(extraction, 20)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_REFERENCE' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('preserves dimensions after monetary cancellation in %s', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#20=IFCCOSTVALUE('Money',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(2.),#10,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Length',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
      "#23=IFCCOSTVALUE('Ratio',$,IFCRATIOMEASURE(1.),$,$,$,$,$,$,$);",
      "#24=IFCCOSTVALUE('Invalid sum',$,$,$,$,$,$,$,.ADD.,(#22,#23));",
    ])));
    expect(evaluateCostValue(extraction, 22)).toMatchObject({
      Amount: '5', Currency: undefined, Dimension: 'length', Diagnostics: [],
    });
    expect(evaluateCostValue(extraction, 24)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it('withholds totals for dangling, negative, or overflowing quantities', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYAREA('Valid',$,$,2.,$);",
      "#11=IFCQUANTITYAREA('Negative',$,$,-1.,$);",
      "#12=IFCQUANTITYAREA('Overflow',$,$,1E9999999,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('negative',$,'Negative',$,$,'N',$,(#20),(#10,#11));",
      "#31=IFCCOSTITEM('overflow',$,'Overflow',$,$,'O',$,(#20),(#10,#12));",
      "#32=IFCCOSTITEM('dangling',$,'Dangling',$,$,'D',$,(#20),(#10,#999));",
      "#33=IFCCOSTITEM('empty',$,'Empty',$,$,'E',$,(#20),());",
    ])));
    for (const id of [30, 31, 32, 33]) {
      const result = evaluateCostItem(extraction, id);
      expect(result.Amount).toBeUndefined();
      expect(result.Diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('evaluates a 5k chain and memoizes a repeated-operand DAG', async () => {
    const chain = ["#1=IFCCOSTVALUE('leaf',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);"];
    for (let id = 2; id <= 5000; id++) {
      chain.push(`#${id}=IFCCOSTVALUE('node',$,$,$,$,$,$,$,.ADD.,(#${id - 1}));`);
    }
    const chainExtraction = extractCostOnDemand(await parse(step('IFC4', chain)));
    expect(evaluateCostValue(chainExtraction, 5000).Amount).toBe('1');

    const dag = ["#1=IFCCOSTVALUE('leaf',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);"];
    for (let id = 2; id <= 27; id++) {
      dag.push(`#${id}=IFCCOSTVALUE('node',$,$,$,$,$,$,$,.ADD.,(#${id - 1},#${id - 1}));`);
    }
    const dagExtraction = extractCostOnDemand(await parse(step('IFC4', dag)));
    expect(evaluateCostValue(dagExtraction, 27).Amount).toBe('67108864');
  }, 15_000);

  it('memoizes shared value graphs across one cost item without losing reference multiplicity', async () => {
    const values = ["#10=IFCCOSTVALUE('leaf',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,$,$);"];
    for (let id = 11; id <= 6009; id++) {
      values.push(`#${id}=IFCCOSTVALUE('node',$,$,$,$,$,$,$,.ADD.,(#${id - 1}));`);
    }
    const repeated = Array.from({ length: 6000 }, () => '#6009').join(',');
    values.push(`#7000=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(${repeated}),$);`);
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT, ...values])));
    expect(evaluateCostItem(extraction, 7000)).toMatchObject({ Amount: '6000', Currency: 'CHF' });
  }, 8_000);

  it('accumulates repeated categorized values linearly while preserving multiplicity', () => {
    const extraction = valueGraph([{
      expressId: 1, Type: 'IfcCostValue', Category: 'Labour',
      AppliedValue: { Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1' },
    }]);
    extraction.Currency = 'CHF';
    extraction.CostItems = [{
      expressId: 2, CostValues: Array.from({ length: 40_000 }, () => 1),
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    }];
    expect(evaluateCostItem(extraction, 2)).toMatchObject({ Amount: '40000', Currency: 'CHF', Diagnostics: [] });
    extraction.CostItems[0].CostValues = Array.from({ length: 60_000 }, () => 1);
    expect(evaluateCostItem(extraction, 2)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId: 2 }),
      ]),
    });
  }, 2_000);

  it('memoizes nested category subtotal reductions while preserving multiplicity', () => {
    const count = 19_000;
    const subtotalIds = Array.from({ length: count }, (_, index) => 100 + index);
    const subtotalValues = subtotalIds.map((expressId): CostValueInfo => ({
      expressId, Type: 'IfcCostValue', Category: 'Material',
    }));
    const extraction = valueGraph([{
      expressId: 1, Type: 'IfcCostValue', Category: 'Material',
      AppliedValue: { Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1' },
    }, ...subtotalValues]);
    extraction.Currency = 'CHF';
    extraction.CostItems = Array.from({ length: 5 }, (_, index) => ({
      expressId: 10 + index, CostValues: subtotalIds,
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    }));
    extraction.CostItems.push({
      expressId: 15, CostValues: Array.from({ length: count }, () => 1),
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    });
    extraction.Relationships = Array.from({ length: 5 }, (_, index) => ({
      expressId: 20 + index, Type: 'IfcRelNests' as const,
      RelatingObject: 10 + index, RelatedObjects: [11 + index],
    }));
    expect(evaluateCostItem(extraction, 10)).toMatchObject({
      Amount: '4.7045881e+25', Currency: 'CHF', Diagnostics: [],
    });
  }, 3_000);

  it('requires direct CostValues references to target IfcCostValue', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#20=IFCAPPLIEDVALUE('base',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('sum',$,$,$,$,$,$,$,.ADD.,(#20));",
      "#30=IFCCOSTITEM('bad',$,'Bad',$,$,'B',$,(#20),$);",
      "#31=IFCCOSTITEM('valid',$,'Valid',$,$,'V',$,(#21),$);",
    ])));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 30, RelatedExpressId: 20 }),
    ]));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId: 30 }),
      ]),
    });
    expect(evaluateCostItem(extraction, 31)).toMatchObject({ Amount: '10', Currency: 'CHF' });
  });

  it('bounds file-controlled applied-value graph work', () => {
    const values: CostValueInfo[] = [{
      expressId: 1, Type: 'IfcCostValue', AppliedValue: { Kind: 'Typed', Type: 'IFCNUMERICMEASURE', Value: '1' },
    }];
    for (let id = 2; id <= 50_001; id++) {
      values.push({ expressId: id, Type: 'IfcCostValue', ArithmeticOperator: 'ADD', Components: [id - 1] });
    }
    expect(evaluateCostValue(valueGraph(values), 50_001)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId: 50_001 }),
      ]),
    });
  });

  it('charges repeated component operands in cold and warmed evaluation order', async () => {
    const repeated = Array.from({ length: 99_996 }, () => '#10').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#10=IFCCOSTVALUE('leaf',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);",
      `#11=IFCCOSTVALUE('sum',$,$,$,$,$,$,$,.ADD.,(${repeated}));`,
      "#20=IFCCOSTITEM('cold',$,'Cold',$,$,'C',$,(#11,#10),$);",
      "#21=IFCCOSTITEM('warmed',$,'Warmed',$,$,'W',$,(#10,#11),$);",
    ])));
    for (const expressId of [20, 21]) {
      expect(evaluateCostItem(extraction, expressId)).toMatchObject({
        Amount: '99997', Diagnostics: [],
      });
    }
  }, 10_000);

  it('schedules repeated component dependencies once in cold and warmed order', async () => {
    const repeated = Array.from({ length: 60_000 }, () => '#10').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('leaf',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,$,$);",
      `#11=IFCCOSTVALUE('sum',$,$,$,$,$,$,$,.ADD.,(${repeated}));`,
      "#20=IFCCOSTITEM('warm',$,'Warm',$,$,'W',$,(#10,#11),$);",
      "#21=IFCCOSTITEM('cold',$,'Cold',$,$,'C',$,(#11,#10),$);",
    ])));
    for (const expressId of [20, 21]) {
      expect(evaluateCostItem(extraction, expressId)).toMatchObject({
        Amount: '60001', Currency: 'CHF', Diagnostics: [],
      });
    }
  }, 10_000);

  it('accumulates many nesting relationships for one parent in linear time', () => {
    const extraction = valueGraph([]);
    extraction.Relationships = Array.from({ length: 20_000 }, (_, index) => ({
      expressId: index + 1, Type: 'IfcRelNests' as const,
      RelatingObject: 1, RelatedObjects: [100_000 + index],
    }));
    const result = evaluateCostItem(extraction, -1);
    expect(result.Amount).toBeUndefined();
    expect(result).toMatchObject({
      Diagnostics: [expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: -1 })],
    });
  }, 2_000);

  it('memoizes a shared normalized quantity graph across nested items', () => {
    const size = 700;
    let childReads = 0;
    const CostQuantities: CostQuantityInfo[] = [{
      expressId: 1, Type: 'IfcQuantityCount', Dimension: 'count', CountValue: '1',
    }];
    for (let expressId = 2; expressId <= size; expressId++) {
      const child = expressId - 1;
      CostQuantities.push({
        expressId, Type: 'IfcPhysicalComplexQuantity',
        get HasQuantities() { childReads++; return [child]; },
      });
    }
    const extraction = valueGraph([{
      expressId: 1_000, Type: 'IfcCostValue',
      AppliedValue: { Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1' },
    }, { expressId: 1_001, Type: 'IfcCostValue', Category: '*' }]);
    extraction.Currency = 'CHF';
    extraction.CostQuantities = CostQuantities;
    const item = (expressId: number, valueId: number, quantities?: number[]) => ({
      expressId, CostValues: [valueId], CostQuantities: quantities,
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    });
    const children = Array.from({ length: size }, (_, index) => item(10_000 + index, 1_000, [size]));
    extraction.CostItems = [item(9_999, 1_001), ...children];
    extraction.Relationships = [{
      expressId: 20_000, Type: 'IfcRelNests', RelatingObject: 9_999,
      RelatedObjects: children.map(child => child.expressId),
    }];
    expect(evaluateCostItem(extraction, 9_999)).toMatchObject({ Amount: '700', Diagnostics: [] });
    expect(childReads).toBeLessThan(5_000);
  });

  it('indexes currency ambiguity and measures once per evaluation call', () => {
    const count = 500;
    let diagnosticReads = 0;
    const unrelated: CostDiagnostic = {
      get Code(): CostDiagnostic['Code'] { diagnosticReads++; return 'INVALID_NUMBER'; },
      Message: 'Unrelated extraction diagnostic', Severity: 'warning',
    };
    const currencyValues: CostValueInfo[] = Array.from({ length: count }, (_, index) => ({
      expressId: index + 1, Type: 'IfcCostValue',
      AppliedValue: { Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1' },
    }));
    const currency = valueGraph(currencyValues);
    currency.Diagnostics = Array.from({ length: count }, () => unrelated);
    currency.CostItems = [{
      expressId: 10_000, CostValues: currencyValues.map(value => value.expressId as number),
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    }];
    expect(evaluateCostItem(currency, 10_000).Amount).toBe('500');
    expect(diagnosticReads).toBe(count);

    let measureReads = 0;
    const measures: CostMeasureWithUnitInfo[] = Array.from({ length: count }, (_, index) => {
      const expressId = 20_000 + index;
      return {
        get expressId() { measureReads++; return expressId; },
        ValueComponent: '1', UnitComponent: 30_000, ValueType: 'IFCMONETARYMEASURE',
      };
    });
    const measureValues: CostValueInfo[] = measures.map((_, index) => ({
      expressId: index + 1, Type: 'IfcCostValue',
      AppliedValue: { Kind: 'Reference', expressId: 20_000 + index },
    }));
    const referenced = valueGraph(measureValues);
    referenced.MeasuresWithUnit = measures;
    referenced.Units = [{ expressId: 30_000, Type: 'IfcMonetaryUnit', Currency: 'CHF' }];
    referenced.CostItems = [{
      expressId: 10_001, CostValues: measureValues.map(value => value.expressId as number),
      globalId: '', name: '', childGlobalIds: [], productExpressIds: [],
      productGlobalIds: [], controllingScheduleGlobalIds: [],
    }];
    expect(evaluateCostItem(referenced, 10_001).Amount).toBe('500');
    expect(measureReads).toBe(count);
  });

  it('handles 5k complex-quantity and conversion-unit chains without recursion', async () => {
    const quantities = ["#1=IFCQUANTITYCOUNT('Leaf',$,$,2.,$);"];
    for (let id = 2; id <= 5000; id++) {
      quantities.push(`#${id}=IFCPHYSICALCOMPLEXQUANTITY('Q${id}',$,(#${id - 1}),'D',$,$);`);
    }
    quantities.push("#6000=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);");
    quantities.push("#6001=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#6000),(#5000));");
    const quantityExtraction = extractCostOnDemand(await parse(step('IFC4', quantities)));
    expect(evaluateCostItem(quantityExtraction, 6001).Amount).toBe('20');

    const units = [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#15000));',
      '#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ];
    for (let index = 1; index <= 5000; index++) {
      const unit = 10000 + index;
      const measure = 20000 + index;
      const previous = index === 1 ? 10 : unit - 1;
      units.push(`#${measure}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#${previous});`);
      units.push(`#${unit}=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'U${index}',#${measure});`);
    }
    units.push("#30001=IFCCOSTVALUE('Value',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);");
    const unitExtraction = extractCostOnDemand(await parse(step('IFC4', units)));
    expect(unitExtraction.Units.find(unit => unit.expressId === 15000)?.Scale).toBe('1');
  }, 20_000);

  it('bounds cumulative exact conversion-scale work for non-unit factors', async () => {
    const units = [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#10500));',
      '#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    ];
    for (let index = 1; index <= 500; index++) {
      const unit = 10_000 + index;
      const measure = 20_000 + index;
      const previous = index === 1 ? 10 : unit - 1;
      units.push(`#${measure}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.234567890123456789),#${previous});`);
      units.push(`#${unit}=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'U${index}',#${measure});`);
    }
    units.push("#30001=IFCCOSTVALUE('Value',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);");
    const extraction = extractCostOnDemand(await parse(step('IFC4', units)));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'UNSUPPORTED_UNIT', Message: expect.stringContaining('evaluation budget') }),
    ]));
    const storedScaleCharacters = extraction.Units.reduce((sum, unit) => sum + (unit.Scale?.length ?? 0), 0);
    expect(storedScaleCharacters).toBeLessThan(100_000);
    expect(extraction.Units.find(unit => unit.expressId === 10_500)?.Scale).toBeUndefined();
  }, 20_000);

  it('ignores valid non-cost IfcRelNests children while retaining invalid-reference failures', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Child value',$,IFCMONETARYMEASURE(100.),$,$,$,'LABOUR',$,$,$);",
      "#11=IFCCOSTVALUE('Total',$,$,$,$,$,'*',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#22=IFCTASK('task',$,'Task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#30=IFCRELNESTS('valid-mixed',$,$,$,#21,(#20,#22));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({ Amount: '100', Diagnostics: [] });

    const invalid = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Child value',$,IFCMONETARYMEASURE(100.),$,$,$,'LABOUR',$,$,$);",
      "#11=IFCCOSTVALUE('Total',$,$,$,$,$,'*',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#30=IFCRELNESTS('invalid-mixed',$,$,$,#21,(#20,#999));",
    ])));
    expect(evaluateCostItem(invalid, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: 999 })]),
    });
  });

  it('preserves shared complex-quantity DAGs without reporting cycles', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYCOUNT('Leaf',$,$,2.,$);",
      "#11=IFCPHYSICALCOMPLEXQUANTITY('Left',$,(#10),'D',$,$);",
      "#12=IFCPHYSICALCOMPLEXQUANTITY('Right',$,(#10),'D',$,$);",
      "#13=IFCPHYSICALCOMPLEXQUANTITY('Root',$,(#11,#12),'D',$,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#13));",
    ])));
    expect(extraction.Diagnostics.some(entry => entry.Code === 'QUANTITY_CYCLE')).toBe(false);
    expect(evaluateCostItem(extraction, 30).Amount).toBe('40');
  });

  it('keeps exact conversion factors and rejects cyclic IFC2X3 date references', async () => {
    const conversion = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#12));',
      '#10=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#11=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.1234567890123456789012345678901234),#10);',
      "#12=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'exact',#11);",
      "#20=IFCCOSTVALUE('Value',$,IFCNUMERICMEASURE(1.),$,$,$,$,$,$,$);",
    ])));
    expect(conversion.Units.find(unit => unit.expressId === 12)?.Scale)
      .toBe('0.1234567890123456789012345678901234');

    const dates = extractCostOnDemand(await parse(step('IFC2X3', [
      '#10=IFCDATEANDTIME(#10,#11);', '#11=IFCLOCALTIME(12,$,$,$,$);',
      "#20=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(1.),$,#10,#10,'LABOUR',$);",
    ])));
    expect(dates.CostValues[0]).toMatchObject({ ApplicableDate: undefined, FixedUntilDate: undefined });
  });

  it('withholds named category totals when any nested item is dangling', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Labour',$,IFCMONETARYMEASURE(100.),$,$,$,'LABOUR',$,$,$);",
      "#11=IFCCOSTVALUE('Total',$,$,$,$,$,'LABOUR',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#30=IFCRELNESTS('nest',$,$,$,#21,(#20,#999));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_REFERENCE' })]),
    });
  });

  it('withholds totals for malformed, empty, or dimensionally invalid quantities', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYCOUNT('Count',$,$,3.,$);",
      "#11=IFCPHYSICALCOMPLEXQUANTITY('Empty',$,(),'D',$,$);",
      "#12=IFCQUANTITYAREA('Area',$,#3,2.,$);",
      "#13=IFCQUANTITYCOUNT('Negative',$,$,-1.,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,'LABOUR',$,$,$);",
      "#21=IFCCOSTVALUE('Total',$,$,$,$,$,'LABOUR',$,$,$);",
      "#30=IFCCOSTITEM('malformed',$,'Malformed',$,$,'M',$,(#20),(#10,'bad'));",
      "#31=IFCCOSTITEM('empty-complex',$,'Empty complex',$,$,'E',$,(#20),(#11));",
      "#32=IFCCOSTITEM('wrong-unit',$,'Wrong unit',$,$,'W',$,(#20),(#12));",
      "#33=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#20),(#10));",
      "#34=IFCCOSTITEM('category',$,'Category',$,$,'T',$,(#21),(#13));",
      "#40=IFCRELNESTS('nest',$,$,$,#34,(#33));",
    ])));
    for (const id of [30, 31, 32, 34]) {
      const result = evaluateCostItem(extraction, id);
      expect(result.Amount, `#${id} must not expose a partial total`).toBeUndefined();
      expect(result.Diagnostics.length).toBeGreaterThan(0);
    }
    expect(evaluateCostItem(extraction, 32).Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' }),
    ]));
  });

  it('preserves malformed complex-quantity and nesting aggregates as invalid', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYCOUNT('Count',$,$,2.,$);",
      "#11=IFCPHYSICALCOMPLEXQUANTITY('Malformed',$,(#10,'bad'),'D',$,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,'Material',$,$,$);",
      "#21=IFCCOSTVALUE('Total',$,$,$,$,$,'*',$,$,$);",
      "#30=IFCCOSTITEM('quantity',$,'Quantity',$,$,'Q',$,(#20),(#11));",
      "#31=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#20),$);",
      "#32=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#21),$);",
      "#40=IFCRELNESTS('malformed-nest',$,$,$,#32,(#31,'bad'));",
    ])));
    expect(evaluateCostItem(extraction, 30).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 32).Amount).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 40 }),
    ]));
  });

  it('rejects conversion units with incompatible or non-positive factors', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4,#5));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#11=IFCCONVERSIONBASEDUNIT($,.AREAUNIT.,'bad-area',#10);",
      '#12=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(-1.),#3);',
      "#13=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'negative',#12);",
      "#20=IFCQUANTITYAREA('Area',$,#11,2.,$);",
      "#21=IFCQUANTITYLENGTH('Length',$,#13,2.,$);",
      "#30=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('area',$,'Area',$,$,'A',$,(#30),(#20));",
      "#41=IFCCOSTITEM('length',$,'Length',$,$,'L',$,(#30),(#21));",
    ])));
    expect(evaluateCostItem(extraction, 40).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 41).Amount).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT', expressId: 11 }),
      expect.objectContaining({ Code: 'INVALID_NUMBER', expressId: 13 }),
    ]));
  });

  it('memoizes repeated-child complex quantity DAGs while preserving multiplicity', async () => {
    const lines = ["#1=IFCQUANTITYCOUNT('Leaf',$,$,1.,$);"];
    for (let id = 2; id <= 19; id++) {
      lines.push(`#${id}=IFCPHYSICALCOMPLEXQUANTITY('Q${id}',$,(#${id - 1},#${id - 1}),'D',$,$);`);
    }
    lines.push("#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);");
    lines.push("#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#19));");
    const extraction = extractCostOnDemand(await parse(step('IFC4', lines)));
    expect(evaluateCostItem(extraction, 30).Amount).toBe('2621440');
  });

  it('invalidates an unresolved UnitBasis even when CostQuantities are absent', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#20=IFCCOSTVALUE('Bad basis',$,IFCMONETARYMEASURE(10.),#999,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),$);",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'UNSUPPORTED_UNIT' })]),
    });
  });

  it('preserves the supported decimal exponent boundary and diagnoses arithmetic underflow', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#10=IFCCOSTVALUE('Boundary',$,IFCNUMERICMEASURE(1E-6144),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Small A',$,IFCNUMERICMEASURE(1E-4000),$,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Small B',$,IFCNUMERICMEASURE(1E-4000),$,$,$,$,$,$,$);",
      "#13=IFCCOSTVALUE('Underflow',$,$,$,$,$,$,$,.MULTIPLY.,(#11,#12));",
    ])));
    expect(evaluateCostValue(extraction, 10)).toMatchObject({ Amount: '1e-6144', Diagnostics: [] });
    expect(evaluateCostValue(extraction, 13)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
    });
  });

  it('diagnoses duplicate nesting without double-counting the child', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Child',$,IFCMONETARYMEASURE(100.),$,$,$,'LABOUR',$,$,$);",
      "#11=IFCCOSTVALUE('Total',$,$,$,$,$,'*',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#30=IFCRELNESTS('first',$,$,$,#21,(#20));",
      "#31=IFCRELNESTS('duplicate',$,$,$,#21,(#20));",
    ])));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MULTIPLE_NESTING_PARENTS' })]),
    });
  });

  it('retains direct process assignments and diagnoses every malformed graph form', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCTASK('task',$,'Task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#10=IFCCOSTITEM('a',$,'A',$,$,'A',$,$,(#40));",
      "#11=IFCCOSTITEM('b',$,'B',$,$,'B',$,$,$);",
      "#20=IFCRELASSIGNSTOPROCESS('direct',$,$,$,(#10),$,#1,$);",
      "#30=IFCRELNESTS('first',$,$,$,#10,(#11));",
      "#31=IFCRELNESTS('duplicate',$,$,$,#10,(#11));",
      "#40=IFCPHYSICALCOMPLEXQUANTITY('cycle',$,(#40),'D',$,$);",
    ])));
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ Type: 'IfcRelAssignsToProcess', RelatedObjects: [10], RelatingProcess: 1 }),
    ]));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'MULTIPLE_NESTING_PARENTS' }),
      expect.objectContaining({ Code: 'QUANTITY_CYCLE' }),
    ]));

    const legacy = extractCostOnDemand(await parse(step('IFC2X3', [
      "#10=IFCCOSTVALUE('A',$,IFCMONETARYMEASURE(1.),$,$,$,$,$);",
      "#11=IFCCOSTVALUE('B',$,IFCMONETARYMEASURE(2.),$,$,$,$,$);",
      "#20=IFCAPPLIEDVALUERELATIONSHIP(#10,(#11),.ADD.,$,$);",
      "#21=IFCAPPLIEDVALUERELATIONSHIP(#11,(#10),.ADD.,$,$);",
    ])));
    expect(legacy.Diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ Code: 'VALUE_CYCLE' })]));
  });

  it('decodes IFC2X3 date references and enum currency and preserves prefixed symbols', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC2X3', [
      "#1=IFCPROJECT('project',$,'Legacy',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCMONETARYUNIT(.CHF.);',
      '#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      '#10=IFCCALENDARDATE(14,3,2011);',
      "#20=IFCCOSTVALUE('Legacy',$,IFCMONETARYMEASURE(1.),$,#10,#10,'LABOUR',$);",
      "#30=IFCCOSTSCHEDULE('schedule',$,'Schedule',$,$,$,$,#10,'DRAFT',$,#10,'S-1',.BUDGET.);",
    ])));
    expect(extraction.Currency).toBe('CHF');
    expect(extraction.CostValues[0]).toMatchObject({ ApplicableDate: '2011-03-14', FixedUntilDate: '2011-03-14' });
    expect(extraction.CostSchedules[0]).toMatchObject({ SubmittedOn: '2011-03-14', UpdateDate: '2011-03-14' });
    expect(extraction.Units.find(unit => unit.expressId === 4)?.Symbol).toBe('mm');
  });

  it('normalizes implicit operands before adding them to explicit non-SI rates', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Rates',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#5);',
      "#10=IFCQUANTITYLENGTH('Length',$,$,1000.,$);",
      "#20=IFCCOSTVALUE('Per metre',$,IFCMONETARYMEASURE(10.),#6,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Per millimetre',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Combined',$,$,$,$,$,$,$,.ADD.,(#20,#21));",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#22),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: '2010', Currency: 'GBP', QuantityApplied: '1', Diagnostics: [],
    });
  });

  it('rejects zero conversion factors instead of returning a zero total', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.),#3);',
      "#6=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'zero',#5);",
      "#10=IFCQUANTITYLENGTH('Length',$,#6,3.,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10));",
    ])));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_NUMBER', expressId: 6 }),
    ]));
    expect(evaluateCostItem(extraction, 30).Amount).toBeUndefined();
  });

  it('diagnoses quantity underflow without applying UnitBasis to a total cost', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCQUANTITYCOUNT('Tiny',$,$,1E-6145,$);",
      "#11=IFCQUANTITYCOUNT('Tenth',$,$,.1,$);",
      '#12=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(10.),#3);',
      "#20=IFCCOSTVALUE('Ordinary',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Basis underflow',$,IFCMONETARYMEASURE(1E-6144),#12,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Extension underflow',$,IFCMONETARYMEASURE(1E-6144),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('quantity',$,'Quantity',$,$,'Q',$,(#20),(#10));",
      "#31=IFCCOSTITEM('basis',$,'Basis',$,$,'B',$,(#21),$);",
      "#32=IFCCOSTITEM('extension',$,'Extension',$,$,'E',$,(#22),(#11));",
    ])));
    for (const id of [30, 32]) {
      expect(evaluateCostItem(extraction, id)).toMatchObject({
        Amount: undefined,
        Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
      });
    }
    expect(evaluateCostItem(extraction, 31)).toMatchObject({ Amount: '1e-6144', Diagnostics: [] });
  });

  it('rejects integer literals in every cost reference aggregate', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#9=IFCQUANTITYCOUNT('Count',$,$,3.,$);",
      "#10=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(13.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Expression',$,$,$,$,$,$,$,.ADD.,(#10,10));",
      "#20=IFCCOSTITEM('values',$,'Values',$,$,'V',$,(#10,10),$);",
      "#21=IFCCOSTITEM('components',$,'Components',$,$,'C',$,(#11),$);",
      "#22=IFCCOSTITEM('quantities',$,'Quantities',$,$,'Q',$,(#10),(#9,9));",
    ])));
    for (const id of [20, 21, 22]) expect(evaluateCostItem(extraction, id).Amount).toBeUndefined();
    expect(extraction.Diagnostics.filter(entry => entry.Code === 'INVALID_LIST')).toHaveLength(3);
  });

  it('preserves malformed UnitBasis presence and withholds the dependent value', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Bad basis',$,IFCMONETARYMEASURE(13.),'bad',$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
    ])));
    expect(extraction.CostValues[0]).toMatchObject({ InvalidUnitBasis: true, UnitBasis: undefined });
    expect(evaluateCostItem(extraction, 20)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'UNSUPPORTED_UNIT' })]),
    });
  });

  it('rejects contradictory typed conversion measures and SI unit names', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Units',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4,#6));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCMEASUREWITHUNIT(IFCAREAMEASURE(2.),#3);',
      '#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.SECOND.);',
      "#7=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'area-as-length',#5);",
      "#10=IFCQUANTITYLENGTH('Converted',$,#7,3.,$);",
      "#11=IFCQUANTITYLENGTH('Bad SI',$,#6,3.,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('converted',$,'Converted',$,$,'C',$,(#20),(#10));",
      "#31=IFCCOSTITEM('si',$,'SI',$,$,'S',$,(#20),(#11));",
    ])));
    expect(evaluateCostItem(extraction, 30).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 31).Amount).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT', expressId: 7 }),
      expect.objectContaining({ Code: 'UNSUPPORTED_UNIT', expressId: 6 }),
    ]));
  });

  it('accepts exponent-form lexical zero without confusing exponent digits for a significand', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Zero',$,IFCMONETARYMEASURE(0E-3),$,$,$,$,$,$,$);",
    ])));
    expect(evaluateCostValue(extraction, 10)).toMatchObject({ Amount: '0', Currency: 'CHF', Diagnostics: [] });
  });

  it('cancels matching rate dimensions during division before multiplying an implicit rate', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Rates',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      '#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#5);',
      "#10=IFCQUANTITYLENGTH('Length',$,$,1000.,$);",
      "#20=IFCCOSTVALUE('Ten per metre',$,IFCMONETARYMEASURE(10.),#6,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Two per metre',$,IFCMONETARYMEASURE(2.),#6,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Ratio',$,$,$,$,$,$,$,.DIVIDE.,(#20,#21));",
      "#23=IFCCOSTVALUE('Two per millimetre',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#24=IFCCOSTVALUE('Product',$,$,$,$,$,$,$,.MULTIPLY.,(#22,#23));",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#24),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({ Amount: '10000', QuantityApplied: '1000' });
  });

  it('rejects bare integer references in relationships, complex quantities, and unit graphs', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Refs',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((3,4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      "#10=IFCQUANTITYCOUNT('Leaf',$,$,2.,$);",
      "#11=IFCPHYSICALCOMPLEXQUANTITY('Complex',$,(10),'D',$,$);",
      "#20=IFCCOSTVALUE('Child',$,IFCMONETARYMEASURE(10.),$,$,$,'MATERIAL',$,$,$);",
      "#21=IFCCOSTVALUE('Total',$,$,$,$,$,'*',$,$,$);",
      "#22=IFCCOSTVALUE('Bad measure',$,#50,$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#21),$);",
      "#31=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#20),(#11));",
      "#32=IFCCOSTITEM('conversion',$,'Conversion',$,$,'X',$,(#20),(#12));",
      "#33=IFCCOSTITEM('measure',$,'Measure',$,$,'M',$,(#22),$);",
      "#40=IFCRELNESTS('nest',$,$,$,#30,(31));",
      "#41=IFCRELNESTS('bad-parent',$,$,$,30,(#31));",
      "#60=IFCCOSTSCHEDULE('schedule',$,'Schedule',$,$,'S',.BUDGET.,$,$,$);",
      "#61=IFCTASK('task',$,'Task',$,$,$,$,$,$,$,$,$,$,$);",
      "#62=IFCWALL('wall',$,'Wall',$,$,$,$,$,$);",
      "#70=IFCRELASSIGNSTOCONTROL('control',$,$,$,(31),$,#60);",
      "#71=IFCRELASSIGNSTOPRODUCT('product',$,$,$,(31),$,#62);",
      "#72=IFCRELDECLARES('declares',$,$,$,#1,(60));",
      "#73=IFCRELASSIGNSTOPROCESS('process',$,$,$,(31),$,#61,$);",
      "#74=IFCRELASSOCIATESAPPLIEDVALUE('applied',$,$,$,(31),20);",
      "#75=IFCRELSCHEDULESCOSTITEMS('legacy',$,$,$,(31),$,#60);",
      '#76=IFCAPPLIEDVALUERELATIONSHIP(20,(21),.ADD.,$,$);',
      '#50=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),3);',
      "#51=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'bad',50);",
      "#12=IFCQUANTITYLENGTH('Converted',$,#51,2.,$);",
    ])));
    expect(evaluateCostItem(extraction, 30).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 31).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 32).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 33).Amount).toBeUndefined();
    expect(evaluateCostItem(extraction, 31).Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 11 }),
    ]));
    expect(extraction.ProjectUnits).toEqual({});
    expect(extraction.Relationships.filter(relation => relation.expressId >= 40)).toEqual(
      expect.arrayContaining([40, 41, 70, 71, 72, 73, 74, 75, 76].map(expressId =>
        expect.objectContaining({ expressId, InvalidReferences: true }))),
    );
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 40 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 2 }),
      expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: 50 }),
      expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: 51 }),
    ]));

    const malformedProject = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Refs',$,$,$,$,$,2);",
      '#2=IFCUNITASSIGNMENT((#3));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#10=IFCCOSTVALUE('value',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
    ])));
    expect(malformedProject.ProjectUnits).toEqual({});
    expect(malformedProject.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: 1 }),
    ]));
  });

  it('rejects coerced numeric fallbacks when the exact STEP token is malformed', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      "#10=IFCCOSTVALUE('Bad exponent',$,IFCMONETARYMEASURE(1.E),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Reference token',$,IFCMONETARYMEASURE(#3),$,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Trailing junk',$,IFCMONETARYMEASURE(1.2junk),$,$,$,$,$,$,$);",
      "#13=IFCQUANTITYCOUNT('Bad quantity',$,$,#3,$);",
      "#20=IFCCOSTITEM('a',$,'A',$,$,'A',$,(#10),$);",
      "#21=IFCCOSTITEM('b',$,'B',$,$,'B',$,(#11),$);",
      "#22=IFCCOSTITEM('c',$,'C',$,$,'C',$,(#12),$);",
      "#23=IFCCOSTITEM('q',$,'Q',$,$,'Q',$,(#10),(#13));",
    ])));
    for (const id of [20, 21, 22, 23]) expect(evaluateCostItem(extraction, id).Amount).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_NUMBER', expressId: 13 }),
    ]));
  });

  it('preserves and validates measure-with-unit value dimensions on every evaluation path', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [...PROJECT,
      '#10=IFCMEASUREWITHUNIT(IFCAREAMEASURE(2.),#3);',
      '#11=IFCMEASUREWITHUNIT(IFCLABEL(2.),#3);',
      "#20=IFCQUANTITYLENGTH('Length',$,$,2.,$);",
      "#30=IFCCOSTVALUE('Bad basis',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#31=IFCCOSTVALUE('Bad applied',$,#10,$,$,$,$,$,$,$);",
      "#32=IFCCOSTVALUE('Bad label',$,#11,$,$,$,$,$,$,$);",
      "#40=IFCCOSTITEM('basis',$,'Basis',$,$,'B',$,(#30),(#20));",
      "#41=IFCCOSTITEM('applied',$,'Applied',$,$,'A',$,(#31),$);",
      "#42=IFCCOSTITEM('label',$,'Label',$,$,'L',$,(#32),$);",
    ])));
    for (const id of [40, 41, 42]) {
      expect(evaluateCostItem(extraction, id)).toMatchObject({
        Amount: undefined,
        Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: expect.stringMatching(/UNIT|REFERENCE/) })]),
      });
    }
    expect(extraction.MeasuresWithUnit).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 10, ValueType: 'IFCAREAMEASURE', ValueDimension: 'area' }),
    ]));
  });

  it('rejects malformed optional presence and conditional components', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Malformed',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4,#5));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.LENGTHUNIT.,.BOGUS.,.METRE.);',
      "#10=IFCQUANTITYLENGTH('Bad unit',$,'bad',2.,$);",
      "#11=IFCQUANTITYLENGTH('Bad prefix',$,#5,2.,$);",
      "#20=IFCCOSTVALUE('Numeric condition',$,IFCMONETARYMEASURE(10.),$,$,$,$,42,$,$);",
      "#21=IFCCOSTVALUE('Conditional child',$,IFCMONETARYMEASURE(10.),$,$,$,$,'Requires context',$,$);",
      "#22=IFCCOSTVALUE('Plain child',$,IFCMONETARYMEASURE(2.),$,$,$,$,$,$,$);",
      "#23=IFCCOSTVALUE('Expression',$,$,$,$,$,$,$,.ADD.,(#21,#22));",
      "#30=IFCCOSTITEM('unit',$,'Unit',$,$,'U',$,(#22),(#10));",
      "#31=IFCCOSTITEM('prefix',$,'Prefix',$,$,'P',$,(#22),(#11));",
      "#32=IFCCOSTITEM('numeric',$,'Numeric',$,$,'N',$,(#20),$);",
      "#33=IFCCOSTITEM('component',$,'Component',$,$,'C',$,(#23),$);",
    ])));
    for (const id of [30, 31, 32, 33]) expect(evaluateCostItem(extraction, id).Amount).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'UNSUPPORTED_UNIT', expressId: 10 }),
      expect.objectContaining({ Code: 'UNSUPPORTED_UNIT', expressId: 5 }),
    ]));
  });

  it('diagnoses project-scale division and subtraction underflow', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Underflow',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#3,#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,.EXA.,.METRE.);',
      "#4=IFCMONETARYUNIT('GBP');",
      '#5=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#10=IFCQUANTITYLENGTH('Tiny',$,#5,1E-6144,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('A',$,IFCNUMERICMEASURE(1.1E-6144),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('B',$,IFCNUMERICMEASURE(1E-6144),$,$,$,$,$,$,$);",
      "#23=IFCCOSTVALUE('Difference',$,$,$,$,$,$,$,.SUBTRACT.,(#21,#22));",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),(#10));",
    ])));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
    });
    expect(evaluateCostValue(extraction, 23)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('diagnoses every %s arithmetic step that underflows', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('A',$,IFCNUMERICMEASURE(1.1E-6144),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Negative B',$,IFCNUMERICMEASURE(-1E-6144),$,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Add underflow',$,$,$,$,$,$,$,.ADD.,(#10,#11));",
      "#13=IFCCOSTVALUE('B',$,IFCNUMERICMEASURE(1E-6144),$,$,$,$,$,$,$);",
      "#14=IFCCOSTVALUE('Subtract underflow',$,$,$,$,$,$,$,.SUBTRACT.,(#10,#13,#11));",
    ])));
    for (const id of [12, 14]) expect(evaluateCostValue(extraction, id)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_NUMBER' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('rejects compound %s rate dimensions during multiplication', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#10=IFCQUANTITYLENGTH('Length',$,$,3.,$);",
      "#20=IFCCOSTVALUE('Money rate',$,IFCMONETARYMEASURE(10.),#8,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Ratio rate',$,IFCNUMERICMEASURE(2.),#8,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Compound',$,$,$,$,$,$,$,.MULTIPLY.,(#20,#21));",
      "#23=IFCCOSTVALUE('Nested compound',$,$,#8,$,$,$,$,.ADD.,(#20));",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#22),(#10));",
      "#31=IFCCOSTITEM('nested',$,'Nested',$,$,'N',$,(#23),(#10));",
    ])));
    for (const id of [30, 31]) expect(evaluateCostItem(extraction, id)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('validates exact %s quantity value wrappers', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCQUANTITYLENGTH('Label',$,$,IFCLABEL(2.),$);",
      "#11=IFCQUANTITYLENGTH('Area',$,$,IFCAREAMEASURE(2.),$);",
      "#12=IFCQUANTITYLENGTH('Length',$,$,IFCLENGTHMEASURE(2.),$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('label',$,'Label',$,$,'L',$,(#20),(#10));",
      "#31=IFCCOSTITEM('area',$,'Area',$,$,'A',$,(#20),(#11));",
      "#32=IFCCOSTITEM('length',$,'Length',$,$,'V',$,(#20),(#12));",
    ])));
    for (const id of [30, 31]) expect(evaluateCostItem(extraction, id)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_VALUE' })]),
    });
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT', expressId: 10 }),
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT', expressId: 11 }),
    ]));
    expect(evaluateCostItem(extraction, 32)).toMatchObject({ Amount: '20', Diagnostics: [] });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('explains every withheld %s category and component result', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#20=IFCCOSTVALUE('Missing category',$,$,$,$,$,'Material',$,$,$);",
      "#21=IFCCOSTVALUE('Empty components',$,$,$,$,$,$,$,.ADD.,());",
      "#22=IFCCOSTVALUE('Malformed components',$,$,$,$,$,$,$,.ADD.,(10));",
    ])));
    for (const id of [20, 21, 22]) expect(evaluateCostValue(extraction, id)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MISSING_VALUE' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('rejects mixed %s rate and dimensionless ADD or SUBTRACT operands', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#3);',
      "#10=IFCQUANTITYLENGTH('Length',$,$,3.,$);",
      "#20=IFCCOSTVALUE('Per metre',$,IFCNUMERICMEASURE(2.),#8,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Dimensionless',$,IFCNUMERICMEASURE(3.),$,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Bad add',$,$,$,$,$,$,$,.ADD.,(#20,#21));",
      "#23=IFCCOSTVALUE('Bad subtract',$,$,$,$,$,$,$,.SUBTRACT.,(#20,#21));",
      "#24=IFCCOSTVALUE('Money',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#25=IFCCOSTVALUE('Add money',$,$,$,$,$,$,$,.MULTIPLY.,(#22,#24));",
      "#26=IFCCOSTVALUE('Subtract money',$,$,$,$,$,$,$,.MULTIPLY.,(#23,#24));",
      "#30=IFCCOSTITEM('add',$,'Add',$,$,'A',$,(#25),(#10));",
      "#31=IFCCOSTITEM('subtract',$,'Subtract',$,$,'S',$,(#26),(#10));",
    ])));
    for (const id of [30, 31]) expect(evaluateCostItem(extraction, id)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('preserves malformed-present %s references without invalidating absence', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Control',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Bad basis',$,IFCMONETARYMEASURE(10.),#bad,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Bad components',$,$,$,$,$,$,$,.ADD.,#4294967296);",
      "#20=IFCCOSTITEM('control',$,'Control',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('basis',$,'Basis',$,$,'B',$,(#11),$);",
      "#22=IFCCOSTITEM('components',$,'Components',$,$,'X',$,(#12),$);",
      "#23=IFCCOSTITEM('quantities',$,'Quantities',$,$,'Q',$,(#10),#4294967296);",
    ])));
    expect(evaluateCostItem(extraction, 20)).toMatchObject({ Amount: '10', Diagnostics: [] });
    for (const id of [21, 22, 23]) {
      const evaluated = evaluateCostItem(extraction, id);
      expect(evaluated.Amount).toBeUndefined();
      expect(evaluated.Diagnostics.length).toBeGreaterThan(0);
    }
    expect(extraction.CostValues.find(value => value.expressId === 11)).toMatchObject({ InvalidUnitBasis: true });
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 12 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 23 }),
    ]));
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('treats empty %s cost slots as malformed presence', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Control',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Bad basis',$,IFCMONETARYMEASURE(10.),,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Bad components',$,$,$,$,$,$,$,.ADD.,);",
      "#20=IFCCOSTITEM('control',$,'Control',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('basis',$,'Basis',$,$,'B',$,(#11),$);",
      "#22=IFCCOSTITEM('components',$,'Components',$,$,'X',$,(#12),$);",
      "#23=IFCCOSTITEM('quantities',$,'Quantities',$,$,'Q',$,(#10),);",
    ])));
    expect(evaluateCostItem(extraction, 20)).toMatchObject({ Amount: '10', Diagnostics: [] });
    for (const id of [21, 22, 23]) {
      expect(evaluateCostItem(extraction, id)).toMatchObject({
        Amount: undefined,
        Diagnostics: expect.arrayContaining([expect.objectContaining({ Severity: expect.stringMatching(/warning|error/) })]),
      });
    }
    expect(extraction.CostValues.find(value => value.expressId === 11)).toMatchObject({ InvalidUnitBasis: true });
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 12 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 23 }),
    ]));
  });

  it.each([
    ['IFC4', '#bad'],
    ['IFC4', '#4294967296'],
    ['IFC4X3_ADD2', '#bad'],
    ['IFC4X3_ADD2', '#4294967296'],
  ])('withholds %s category totals for malformed AppliedValue %s', async (schema, token) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Child value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      `#11=IFCCOSTVALUE('Malformed wildcard',$,${token},$,$,$,'*',$,$,$);`,
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#30=IFCRELNESTS('nest',$,$,$,#21,(#20));",
    ])));
    expect(extraction.CostValues.find(value => value.expressId === 11)?.AppliedValue).toMatchObject({
      Kind: 'Unsupported',
    });
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([
        expect.objectContaining({ Code: 'UNSUPPORTED_APPLIED_VALUE', expressId: 11 }),
      ]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('keeps %s total costs whole when CostQuantities is absent', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(10.),#3);',
      "#10=IFCCOSTVALUE('Total with metadata',$,IFCMONETARYMEASURE(100.),#8,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
    ])));
    expect(evaluateCostItem(extraction, 20)).toMatchObject({
      Amount: '100', Currency: 'CHF', Dimension: undefined, Diagnostics: [],
    });
    expect(evaluateCostValue(extraction, 10)).toMatchObject({
      Amount: '10', Currency: 'CHF', Dimension: 'length', Diagnostics: [],
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('retains malformed required %s relationship endpoints', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Child value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#11=IFCCOSTVALUE('Wildcard total',$,$,$,$,$,'*',$,$,$);",
      "#20=IFCCOSTITEM('child',$,'Child',$,$,'C',$,(#10),$);",
      "#21=IFCCOSTITEM('parent',$,'Parent',$,$,'P',$,(#11),$);",
      "#30=IFCRELNESTS('valid',$,$,$,#21,(#20));",
      "#31=IFCRELNESTS('invalid',$,$,$,#21,$);",
      "#32=IFCRELASSIGNSTOCONTROL('control',$,$,$,(#21),$,#bad);",
    ])));
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 31, Type: 'IfcRelNests', InvalidReferences: true }),
      expect.objectContaining({ expressId: 32, Type: 'IfcRelAssignsToControl', InvalidReferences: true }),
    ]));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 31 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 32 }),
    ]));
    expect(evaluateCostItem(extraction, 21)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MULTIPLE_NESTING_PARENTS' })]),
    });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('ignores comments around %s entity delimiters', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE/* ( annotation */('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$)/* ) trailing */;",
      "#11=IFCCOSTVALUE('Component',$,IFCMONETARYMEASURE(7.),$,$,$,$,$,$,$);",
      "#12=IFCCOSTVALUE('Expression',$,$,$,$,$,$,$,.ADD.,(#11))/* ) trailing */;",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10,#12),$);",
    ])));
    expect(extraction.CostValues.find(value => value.expressId === 12)?.Components).toEqual([11]);
    expect(evaluateCostItem(extraction, 20)).toMatchObject({ Amount: '17', Currency: 'CHF', Diagnostics: [] });
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('retains malformed required %s process endpoints', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
      "#30=IFCRELASSIGNSTOPROCESS('missing',$,$,$,(#20),$,$,$);",
      "#31=IFCRELASSIGNSTOPROCESS('malformed',$,$,$,(#20),$,#bad,$);",
      "#32=IFCRELASSIGNSTOPROCESS('dangling',$,$,$,(#20),$,#999,$);",
      "#33=IFCRELASSIGNSTOPROCESS('wrong-type',$,$,$,(#20),$,#3,$);",
      "#34=IFCTASK('task',$,'Task',$,$,$,$,$,$,.F.,$,$,.CONSTRUCTION.);",
      "#35=IFCRELASSIGNSTOPROCESS('bad-related',$,$,$,(#20,#998),$,#34,$);",
    ])));
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, Type: 'IfcRelAssignsToProcess', InvalidReferences: true }),
      expect.objectContaining({ expressId: 31, Type: 'IfcRelAssignsToProcess', InvalidReferences: true }),
      expect.objectContaining({ expressId: 32, RelatingProcess: 999, InvalidReferences: true }),
      expect.objectContaining({ expressId: 33, RelatingProcess: 3, InvalidReferences: true }),
      expect.objectContaining({ expressId: 35, RelatedObjects: [20, 998], InvalidReferences: true }),
    ]));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 30 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 31 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 32 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 33 }),
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 35 }),
    ]));
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('validates cost-relevant %s control and product endpoints', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#10=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
      "#30=IFCRELASSIGNSTOCONTROL('control-dangling',$,$,$,(#20),$,#999);",
      "#31=IFCRELASSIGNSTOCONTROL('control-wrong',$,$,$,(#20),$,#3);",
      "#32=IFCRELASSIGNSTOCONTROL('related-dangling',$,$,$,(#20,#998),$,#20);",
      "#33=IFCRELASSIGNSTOPRODUCT('product-dangling',$,$,$,(#20),$,#999);",
      "#34=IFCRELASSIGNSTOPRODUCT('product-wrong',$,$,$,(#20),$,#3);",
      "#35=IFCRELASSIGNSTOPRODUCT('product-related-dangling',$,$,$,(#20,#998),$,#20);",
    ])));
    for (const expressId of [30, 31, 32, 33, 34, 35]) {
      expect(extraction.Relationships).toEqual(expect.arrayContaining([
        expect.objectContaining({ expressId, InvalidReferences: true }),
      ]));
      expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId }),
      ]));
    }
  });

  it('uses the schema-specific IfcRelAssignsToProduct select', async () => {
    const relationship = "#30=IFCRELASSIGNSTOPRODUCT('product-type',$,$,$,(#20),$,#21);";
    const type = "#21=IFCWALLTYPE('type',$,'Type',$,$,$,$,$,$,.STANDARD.);";
    const legacy = extractCostOnDemand(await parse(step('IFC2X3', [
      "#20=IFCCOSTITEM('item',$,'Item',$,$);", type, relationship,
    ])));
    const modern = extractCostOnDemand(await parse(step('IFC4', [
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,$,$);", type, relationship,
    ])));
    expect(legacy.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, RelatingProduct: 21, InvalidReferences: true }),
    ]));
    expect(legacy.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 30 }),
    ]));
    expect(modern.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, RelatingProduct: 21, InvalidReferences: undefined }),
    ]));
  });

  it('uses the schema-specific IfcRelAssignsToProcess select', async () => {
    const relationship = "#30=IFCRELASSIGNSTOPROCESS('process-type',$,$,$,(#20),$,#21,$);";
    const type = "#21=IFCTASKTYPE('type',$,'Type',$,$,$,$,$,$,$,$,.NOTDEFINED.);";
    const legacy = extractCostOnDemand(await parse(step('IFC2X3', [
      "#20=IFCCOSTITEM('item',$,'Item',$,$);", type, relationship,
    ])));
    const modern = extractCostOnDemand(await parse(step('IFC4', [
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,$,$);", type, relationship,
    ])));
    expect(legacy.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, RelatingProcess: 21, InvalidReferences: true }),
    ]));
    expect(legacy.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INVALID_LIST', expressId: 30 }),
    ]));
    expect(modern.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, RelatingProcess: 21, InvalidReferences: undefined }),
    ]));
  });

  it('preserves legacy UnitBasis fields independently from canonical validation', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Cost project',$,$,$,$,$,#2);",
      '#2=IFCUNITASSIGNMENT((#4));',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#4=IFCMONETARYUNIT('CHF');",
      '#10=IFCMEASUREWITHUNIT(IFCPOSITIVELENGTHMEASURE(2.),#3);',
      '#11=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(2.),#999);',
      "#12=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE('bad'),#3);",
      "#20=IFCCOSTVALUE('Legacy typed rate',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Dangling-unit rate',$,IFCMONETARYMEASURE(10.),#11,$,$,$,$,$,$);",
      "#22=IFCCOSTVALUE('Malformed-value rate',$,IFCMONETARYMEASURE(10.),#12,$,$,$,$,$,$);",
    ])));
    expect(extraction.CostValues.find(value => value.expressId === 20)?.unitBasis).toEqual({
      valueComponent: 2, unitSymbol: 'm', unitSiScale: 1,
    });
    expect(extraction.CostValues.find(value => value.expressId === 21)?.unitBasis).toEqual({
      valueComponent: 2, unitSymbol: undefined, unitSiScale: undefined,
    });
    expect(extraction.CostValues.find(value => value.expressId === 22)?.unitBasis).toEqual({
      valueComponent: undefined, unitSymbol: 'm', unitSiScale: 1,
    });
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'INCOMPATIBLE_UNIT', expressId: 10 }),
      expect.objectContaining({ Code: 'MISSING_REFERENCE', expressId: 999 }),
    ]));
  });

  it.each(['#3,#4', '#4,#3'])('withholds totals for conflicting project currencies in order %s', async (order) => {
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#1=IFCPROJECT('project',$,'Currencies',$,$,$,$,$,#2);",
      `#2=IFCUNITASSIGNMENT((${order}));`,
      "#3=IFCMONETARYUNIT('CHF');", "#4=IFCMONETARYUNIT('EUR');",
      "#20=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#20),$);",
    ])));
    expect(extraction.Currency).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'MIXED_CURRENCY', expressId: 2 }),
    ]));
    expect(evaluateCostItem(extraction, 30)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'MIXED_CURRENCY' })]),
    });
  });

  it('shares the evaluation budget across nested items with a common expression', () => {
    const size = 800;
    const CostValues: CostValueInfo[] = [{
      expressId: 1, Type: 'IfcCostValue',
      AppliedValue: { Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '1' },
    }];
    for (let expressId = 2; expressId <= size; expressId++) {
      CostValues.push({ expressId, Type: 'IfcCostValue', ArithmeticOperator: 'ADD', Components: [expressId - 1] });
    }
    CostValues.push({ expressId: size + 1, Type: 'IfcCostValue', Category: '*' });
    const item = (expressId: number, valueId: number) => ({
      expressId, CostValues: [valueId], globalId: '', name: '', childGlobalIds: [],
      productExpressIds: [], productGlobalIds: [], controllingScheduleGlobalIds: [],
    });
    const children = Array.from({ length: size }, (_, index) => item(10_000 + index, size));
    const extraction = valueGraph(CostValues);
    extraction.Currency = 'CHF';
    extraction.CostItems = [item(9_999, size + 1), ...children];
    extraction.Relationships = [{
      expressId: 20_000, Type: 'IfcRelNests', RelatingObject: 9_999,
      RelatedObjects: children.map(child => child.expressId),
    }];
    expect(evaluateCostItem(extraction, 9_999)).toMatchObject({
      Amount: undefined,
      Diagnostics: expect.arrayContaining([expect.objectContaining({ Code: 'INVALID_LIST' })]),
    });
  });

  it('validates all IFC2X3 cost relationship endpoints while retaining the edges', async () => {
    const extraction = extractCostOnDemand(await parse(step('IFC2X3', [
      "#10=IFCCOSTITEM('item',$,'Item',$,$);",
      "#20=IFCAPPLIEDVALUE('value',$,IFCMONETARYMEASURE(10.),$,$,$,$,$,$,$);",
      "#30=IFCRELASSOCIATESAPPLIEDVALUE('missing',$,$,$,(#10),#999);",
      "#31=IFCRELSCHEDULESCOSTITEMS('missing',$,$,$,(#10),$,#999);",
      '#32=IFCAPPLIEDVALUERELATIONSHIP(#20,(#999),.ADD.,$,$);',
      "#33=IFCRELASSOCIATESAPPLIEDVALUE('related-wrong',$,$,$,(#10,#3),#20);",
      "#34=IFCRELASSOCIATESAPPLIEDVALUE('value-wrong',$,$,$,(#10),#3);",
      "#35=IFCRELSCHEDULESCOSTITEMS('related-wrong',$,$,$,(#10,#3),$,#40);",
      "#36=IFCRELSCHEDULESCOSTITEMS('control-wrong',$,$,$,(#10),$,#20);",
      '#37=IFCAPPLIEDVALUERELATIONSHIP(#3,(#20),.ADD.,$,$);',
      '#38=IFCAPPLIEDVALUERELATIONSHIP(#20,(#3),.ADD.,$,$);',
      '#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
      "#40=IFCCOSTSCHEDULE('schedule',$,'Schedule',$,$,$,$,$,$,$,$,'S',.BUDGET.);",
    ])));
    for (let expressId = 30; expressId <= 38; expressId++) {
      expect(extraction.Relationships).toEqual(expect.arrayContaining([
        expect.objectContaining({ expressId, InvalidReferences: true }),
      ]));
      expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId }),
      ]));
    }
  });

  it.each(['IFC4', 'IFC4X3_ADD2'])('validates retained %s nesting and declaration endpoints', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,$,$);",
      "#30=IFCRELNESTS('nest-parent-dangling',$,$,$,#999,(#20));",
      "#31=IFCRELNESTS('nest-parent-wrong',$,$,$,#3,(#20));",
      "#32=IFCRELNESTS('nest-related-dangling',$,$,$,#20,(#20,#998));",
      "#33=IFCRELNESTS('nest-related-wrong',$,$,$,#20,(#20,#3));",
      "#34=IFCRELDECLARES('declare-context-dangling',$,$,$,#999,(#20));",
      "#35=IFCRELDECLARES('declare-context-wrong',$,$,$,#3,(#20));",
      "#36=IFCRELDECLARES('declare-related-dangling',$,$,$,#1,(#20,#998));",
      "#37=IFCRELDECLARES('declare-related-wrong',$,$,$,#1,(#20,#3));",
    ])));
    for (const expressId of [30, 31, 32, 33, 34, 35, 36, 37]) {
      expect(extraction.Relationships).toEqual(expect.arrayContaining([
        expect.objectContaining({ expressId, InvalidReferences: true }),
      ]));
      expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ Code: 'INVALID_LIST', expressId }),
      ]));
    }
  });

  it('keeps compatibility value trees cycle-safe and JSON-serializable', async () => {
    const chain = [
      "#10=IFCCOSTVALUE('self',$,$,$,$,$,$,$,.ADD.,(#10));",
      "#11=IFCCOSTVALUE('mutual-a',$,$,$,$,$,$,$,.ADD.,(#12));",
      "#12=IFCCOSTVALUE('mutual-b',$,$,$,$,$,$,$,.ADD.,(#11));",
    ];
    for (let id = 20; id <= 50; id++) {
      const components = id === 20 ? '$' : `(#${id - 1})`;
      chain.push(`#${id}=IFCCOSTVALUE('deep-${id}',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,.ADD.,${components});`);
    }
    chain.push("#60=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10,#11,#50),$);");
    const extraction = extractCostOnDemand(await parse(step('IFC4', chain)));
    expect(() => JSON.stringify(extraction)).not.toThrow();
    expect(extraction.CostValues.find(value => value.expressId === 10)?.Components).toEqual([10]);
    expect(extraction.CostValues.find(value => value.expressId === 10)?.components).toBeUndefined();
    expect(extraction.CostValues.find(value => value.expressId === 11)?.components?.[0]?.components).toBeUndefined();
    const compatibilityRoot = extraction.CostItems[0].costValues?.find(value => value.expressId === 50);
    expect(compatibilityRoot).toBeDefined();
    let compatibility = compatibilityRoot;
    let compatibilityDepth = 0;
    while (compatibility?.components?.[0]) {
      compatibilityDepth++;
      compatibility = compatibility.components[0];
    }
    expect(compatibilityDepth).toBeGreaterThan(0);
    expect(compatibilityDepth).toBeLessThanOrEqual(21);
    expect(extraction.CostValues.find(value => value.expressId === 50)?.Components).toEqual([49]);
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'VALUE_CYCLE', expressId: 10 }),
      expect.objectContaining({ Code: 'VALUE_CYCLE' }),
    ]));
  });

  it('diagnoses compatibility component truncation across the shared root budget', async () => {
    const repeated = Array.from({ length: 100_000 }, () => '#10').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      "#10=IFCCOSTVALUE('Leaf',$,IFCMONETARYMEASURE(1.),$,$,$,$,$,$,$);",
      `#11=IFCCOSTVALUE('First',$,$,$,$,$,$,$,.ADD.,(${repeated}));`,
      "#12=IFCCOSTVALUE('Second',$,$,$,$,$,$,$,.ADD.,(#10));",
      "#20=IFCCOSTITEM('first',$,'First',$,$,'F',$,(#11),$);",
      "#21=IFCCOSTITEM('second',$,'Second',$,$,'S',$,(#12),$);",
    ])));
    expect(extraction.CostValues.find(value => value.expressId === 11)?.components).toHaveLength(100_000);
    expect(extraction.CostValues.find(value => value.expressId === 12)?.components).toBeUndefined();
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        Code: 'INVALID_LIST', expressId: 12,
        Message: expect.stringContaining('shared 100000-component budget'),
      }),
    ]));
  }, 15_000);

  it('charges repeated shared-child cycle edges against the compatibility budget', async () => {
    const count = 32_000;
    const repeatedChild = Array.from({ length: count }, () => '#10').join(',');
    const repeatedSelf = Array.from({ length: count }, () => '#11').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC4', [
      `#10=IFCCOSTVALUE('Root',$,$,$,$,$,$,$,.ADD.,(${repeatedSelf}));`,
      `#11=IFCCOSTVALUE('Shared cycle',$,$,$,$,$,$,$,.ADD.,(${repeatedChild}));`,
      "#20=IFCCOSTITEM('item',$,'Item',$,$,'I',$,(#10),$);",
    ])));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'VALUE_CYCLE' }),
      expect.objectContaining({
        Code: 'INVALID_LIST', Message: expect.stringContaining('shared 100000-component budget'),
      }),
    ]));
  }, 10_000);

  it('handles file-controlled applied-value component counts without argument-stack overflow', async () => {
    const repeated = Array.from({ length: 130_000 }, () => '#20').join(',');
    const extraction = extractCostOnDemand(await parse(step('IFC2X3', [
      "#20=IFCCOSTVALUE('Value',$,IFCMONETARYMEASURE(10.),$,$,$,'Labour',$);",
      `#30=IFCAPPLIEDVALUERELATIONSHIP(#20,(${repeated}),.ADD.,$,$);`,
    ])));
    expect(extraction.Relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ expressId: 30, Components: expect.arrayContaining([20]) }),
    ]));
    expect(extraction.Diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ Code: 'VALUE_CYCLE', expressId: 20 }),
    ]));
  }, 10_000);

  it.each(['IFC4', 'IFC4X3_ADD2'])('keeps non-finite %s conversions out of compatibility numbers', async (schema) => {
    const extraction = extractCostOnDemand(await parse(step(schema, [...PROJECT,
      '#8=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1E400),#3);',
      "#9=IFCCONVERSIONBASEDUNIT($,.LENGTHUNIT.,'Huge unit',#8);",
      '#10=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#9);',
      '#13=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1E-400),#3);',
      "#11=IFCQUANTITYLENGTH('Huge quantity',$,$,1E400,$);",
      "#12=IFCQUANTITYLENGTH('Huge scale',$,#9,2.,$);",
      "#14=IFCQUANTITYLENGTH('Tiny quantity',$,$,1E-400,$);",
      "#20=IFCCOSTVALUE('Rate',$,IFCMONETARYMEASURE(10.),#10,$,$,$,$,$,$);",
      "#21=IFCCOSTVALUE('Tiny',$,IFCNUMERICMEASURE(1E-400),#13,$,$,$,$,$,$);",
      "#30=IFCCOSTITEM('huge quantity',$,'Huge quantity',$,$,'Q',$,(#20),(#11));",
      "#31=IFCCOSTITEM('huge scale',$,'Huge scale',$,$,'S',$,(#20),(#12));",
      "#32=IFCCOSTITEM('tiny quantity',$,'Tiny quantity',$,$,'T',$,(#21),(#14));",
    ])));
    const hugeQuantity = extraction.CostItems.find(item => item.expressId === 30);
    const hugeScale = extraction.CostItems.find(item => item.expressId === 31);
    expect(hugeQuantity).toBeDefined();
    expect(hugeScale).toBeDefined();
    expect(hugeQuantity?.costQuantities).toBeUndefined();
    expect(hugeScale?.costQuantities).toEqual([expect.objectContaining({ value: 2 })]);
    expect(hugeScale?.costQuantities?.[0]).not.toHaveProperty('explicitUnitSiScale');
    expect(extraction.CostValues.find(value => value.expressId === 20)?.unitBasis).toMatchObject({
      valueComponent: 1,
      unitSiScale: undefined,
    });
    expect(extraction.CostValues.find(value => value.expressId === 21)).toMatchObject({
      appliedValue: undefined,
      unitBasis: { valueComponent: undefined, unitSiScale: 1 },
    });
    expect(extraction.CostItems.find(item => item.expressId === 32)?.costQuantities).toBeUndefined();
    expect(extraction.CostQuantities.find(quantity => quantity.expressId === 11)?.LengthValue).toBe('1E400');
  });

  it('keeps the legacy CostValueInfo construction source-compatible', () => {
    const legacy: CostValueInfo = { appliedValue: 10 };
    expect(legacy.appliedValue).toBe(10);
  });
});
