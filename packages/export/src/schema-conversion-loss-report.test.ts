/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, vi } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser } from '@ifc-lite/parser';
import { classifyEntityTypeConversion, analyzeConversionLoss } from './schema-conversion-loss-report.js';
import { exportToStep } from './step-exporter.js';

describe('classifyEntityTypeConversion', () => {
  it('is identity when schemas match', () => {
    expect(classifyEntityTypeConversion('IFCWALL', 'IFC4', 'IFC4')).toEqual({
      targetType: 'IFCWALL',
      kind: 'identity',
      droppedAttributes: [],
    });
  });

  it('is renamed (lossless) for a type that passes through with no attribute drop', () => {
    const info = classifyEntityTypeConversion('IFCWALL', 'IFC4', 'IFC4X3');
    expect(info.kind).toBe('identity');
  });

  it('is lossy for the structural load-case rename: SelfWeightCoefficients has no IFC2X3 slot', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALLOADCASE', 'IFC4', 'IFC2X3');
    expect(info.targetType).toBe('IFCSTRUCTURALLOADGROUP');
    expect(info.kind).toBe('lossy');
    expect(info.droppedAttributes).toEqual(['SelfWeightCoefficients']);
  });

  it('is lossy for the structural curve-action rename: PredefinedType has no IFC2X3 slot', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALCURVEACTION', 'IFC4', 'IFC2X3');
    expect(info.targetType).toBe('IFCSTRUCTURALLINEARACTION');
    expect(info.kind).toBe('lossy');
    expect(info.droppedAttributes).toEqual(['PredefinedType']);
  });

  it('is proxied for a rooted type IFC2X3 has no representation for at all', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALCURVEREACTION', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('proxied');
    expect(info.targetType).toBe('IFCPROXY');
    expect(info.droppedAttributes.length).toBeGreaterThan(0);
  });

  it('is blocked for a non-rooted type IFC2X3 has no representation for at all', () => {
    const info = classifyEntityTypeConversion('IFCSTRUCTURALLOADCONFIGURATION', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('blocked');
    expect(info.droppedAttributes).toEqual(['Name', 'Values', 'Locations']);
  });

  it('matches the known IFCTRIANGULATEDFACESET blocked case (existing resolveUnrepresentedEntity contract)', () => {
    const info = classifyEntityTypeConversion('IFCTRIANGULATEDFACESET', 'IFC4', 'IFC2X3');
    expect(info.kind).toBe('blocked');
  });

  it('is proxied via shouldSkipEntity (not the attribute-table branch) and names only what the product proxy drops', () => {
    // IFCALIGNMENTHORIZONTAL hits `shouldSkipEntity`, a DIFFERENT code path
    // than the `!tgtAttrs` branch the other proxied/blocked cases exercise.
    // Its proxy keeps IfcProduct's attributes 1 to 6 and mints the GlobalId
    // (`productProxy`, #7683), so only the source GlobalId is lost.
    const info = classifyEntityTypeConversion('IFCALIGNMENTHORIZONTAL', 'IFC4X3', 'IFC4');
    expect(info).toEqual({ targetType: 'IFCPROXY', kind: 'proxied', droppedAttributes: ['GlobalId'] });
    // IfcAlignment's own PredefinedType has no IfcProxy slot.
    expect(classifyEntityTypeConversion('IFCALIGNMENT', 'IFC4X3', 'IFC4').droppedAttributes).toEqual([
      'GlobalId',
      'PredefinedType',
    ]);
  });

  it('is identity for a lossless pad (IFC2X3 → IFC4 appends PredefinedType to IfcWall, nothing source-side disappears)', () => {
    const info = classifyEntityTypeConversion('IFCWALL', 'IFC2X3', 'IFC4');
    expect(info).toEqual({ targetType: 'IFCWALL', kind: 'identity', droppedAttributes: [] });
  });

  it('is lossy with an EMPTY droppedAttributes when same-named attributes exist on both sides but are reordered, not appended', () => {
    // IfcMaterialProperties: IFC2X3 ["Material"], IFC4 ["Name","Description",
    // "Properties","Material"] — "Material" exists in both, but not at
    // position 0, so neither list is a strict prefix of the other and
    // `convertRecord` leaves the single positional value under the new
    // 4-attribute shape untouched, landing it in `Name`'s slot instead of
    // vanishing. `droppedAttributes` correctly finds no NAME missing, even
    // though the record is misconverted.
    const info = classifyEntityTypeConversion('IFCMATERIALPROPERTIES', 'IFC2X3', 'IFC4');
    expect(info).toEqual({ targetType: 'IFCMATERIALPROPERTIES', kind: 'lossy', droppedAttributes: [] });
  });
});

describe('analyzeConversionLoss', () => {
  function storeOf(byType: Record<string, number[]>) {
    return { entityIndex: { byType: new Map(Object.entries(byType)), byId: new Map() as never } };
  }

  it('keeps blocking entries in a type-only preview with a source placeholder (#11007)', () => {
    const store = { ...storeOf({ IFCTRIANGULATEDFACESET: [42] }), source: EMPTY_SOURCE_BYTES };
    const report = analyzeConversionLoss(store, 'IFC4', 'IFC2X3');
    expect(report.hasBlocking).toBe(true);
    expect(report.entries).toMatchObject([{ sourceType: 'IFCTRIANGULATEDFACESET', kind: 'blocked', expressIds: [42] }]);
  });

  it('is empty when the schemas match', () => {
    const report = analyzeConversionLoss(storeOf({ IFCWALL: [1, 2] }), 'IFC4', 'IFC4');
    expect(report.hasLoss).toBe(false);
    expect(report.hasBlocking).toBe(false);
    expect(report.entries).toEqual([]);
  });

  it('omits identity types entirely (IfcWall is attribute-for-attribute unchanged IFC4 → IFC4X3)', () => {
    const report = analyzeConversionLoss(storeOf({ IFCWALL: [1], IFCSLAB: [2, 3] }), 'IFC4', 'IFC4X3');
    expect(report.entries).toEqual([]);
    expect(report.hasLoss).toBe(false);
  });

  it('does not silently report "no loss" for an IFC5 source (no generated attribute table, but shouldSkipEntity still proxies alignment types)', () => {
    const report = analyzeConversionLoss(storeOf({ IFCALIGNMENTHORIZONTAL: [1, 2] }), 'IFC5', 'IFC4');
    expect(report.hasLoss).toBe(true);
    expect(report.entries).toMatchObject([{ sourceType: 'IFCALIGNMENTHORIZONTAL', kind: 'proxied', count: 2 }]);
  });

  it('names every blocked and lossy structural type the real Constructivity fixture contains, with their express ids', () => {
    const report = analyzeConversionLoss(
      storeOf({
        IFCSTRUCTURALANALYSISMODEL: [209],
        IFCSTRUCTURALLOADCASE: [312],
        IFCSTRUCTURALCURVEACTION: [317],
        IFCSTRUCTURALLOADCONFIGURATION: [326, 2772, 2780, 2788],
        IFCSTRUCTURALCURVEREACTION: [2773, 2781, 2789],
      }),
      'IFC4',
      'IFC2X3',
    );

    expect(report.hasBlocking).toBe(true);
    expect(report.hasLoss).toBe(true);

    const byType = new Map(report.entries.map((e) => [e.sourceType, e]));
    // Pre-existing (not part of this fix): IFC4 appended `SharedPlacement` to
    // IfcStructuralAnalysisModel, so the strict-prefix trim into IFC2X3 drops
    // it — real, if minor, loss the report should still name.
    expect(byType.get('IFCSTRUCTURALANALYSISMODEL')).toMatchObject({
      kind: 'lossy',
      droppedAttributes: ['SharedPlacement'],
    });
    expect(byType.get('IFCSTRUCTURALLOADCASE')?.kind).toBe('lossy');
    expect(byType.get('IFCSTRUCTURALCURVEACTION')?.kind).toBe('lossy');
    expect(byType.get('IFCSTRUCTURALLOADCONFIGURATION')).toMatchObject({
      kind: 'blocked',
      count: 4,
      expressIds: [326, 2772, 2780, 2788],
    });
    expect(byType.get('IFCSTRUCTURALCURVEREACTION')).toMatchObject({ kind: 'proxied', count: 3 });

    const lines = report.describe();
    expect(lines.some((l) => l.includes('IFCSTRUCTURALLOADCONFIGURATION') && l.includes('#326'))).toBe(true);
    expect(lines.some((l) => l.includes('IFCSTRUCTURALCURVEREACTION'))).toBe(true);
  });

  it.each([
    [['(#3)'], []],
    [['(#3,#6,#7)'], [5]],
    [['/* before */(#3,/* empty */$)/* after */'], []],
    [['(#3)', '(#3,#6,#7)'], [10]],
  ] as const)('reports only the approvals discarded from %j (#10763, PR #10781)', async (related, lostIds) => {
    const relationships = related.map((set, index) => `#${5 + 5 * index}=IFCAPPROVALRELATIONSHIP('n','d',#4,${set});`).join('\n');
    const text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('approval.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"
      + relationships + "\nENDSEC;\nEND-ISO-10303-21;\n";
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
    const report = analyzeConversionLoss(store, 'IFC4', 'IFC2X3');
    expect(report.hasLoss).toBe(lostIds.length > 0);
    expect(report.entries).toEqual(lostIds.length ? [{
      sourceType: 'IFCAPPROVALRELATIONSHIP', targetType: 'IFCAPPROVALRELATIONSHIP',
      kind: 'lossy', count: lostIds.length, expressIds: lostIds, droppedAttributes: ['RelatedApprovals'],
    }] : []);
  });

  it.each(['(#20)', '(#20,#21)'])('reports an up-only BenchmarkValues SET %s on downgrade (#10807)', async (set) => {
    const text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('objective.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n"
      + `#5=IFCOBJECTIVE('id',$,'Objective',$,$,$,$,${set},$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n`;
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
    const report = analyzeConversionLoss(store, 'IFC4', 'IFC2X3');
    expect(report.entries.find(({ sourceType }) => sourceType === 'IFCOBJECTIVE')).toMatchObject({
      expressIds: [5],
      droppedAttributes: expect.arrayContaining(['BenchmarkValues']),
    });
  });

  it('skips a type the store lists with zero instances', () => {
    const report = analyzeConversionLoss(storeOf({ IFCSTRUCTURALLOADCONFIGURATION: [] }), 'IFC4', 'IFC2X3');
    expect(report.entries).toEqual([]);
  });
});

// #9668: what an IFC2X3 <-> IFC4 structural carrier brings back on the round
// trip is not lost. Each case converts there and back to show it.
describe('analyzeConversionLoss and the structural carriers (#9668)', () => {
  const model = (schema: string, data: string): string =>
    `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
  const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  const line = (step: string, id: number) => step.split('\n').find((l) => l.startsWith(`#${id}=`));
  const roundTrip = async (text: string, from: 'IFC2X3' | 'IFC4', via: 'IFC2X3' | 'IFC4') =>
    exportToStep(await parse(exportToStep(await parse(text), { schema: via })), { schema: from });
  // The owner history records lose attributes of their own; only the structural ones are asked about.
  const losses = async (text: string, from: 'IFC2X3' | 'IFC4', to: 'IFC2X3' | 'IFC4') =>
    analyzeConversionLoss(await parse(text), from, to).entries.filter((e) => e.sourceType.startsWith('IFCSTRUCTURAL'))
      .map((e) => ({ type: e.sourceType, ids: [...e.expressIds], lost: [...e.droppedAttributes] }));
  const OWNER = `#1=IFCPERSON($,'P',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'O',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','A','A');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT($,#8);
#10=IFCLOCALPLACEMENT($,#7);
#11=IFCSTRUCTURALLOADSINGLEFORCE('F',0.,0.,-5.,0.,0.,0.);
#12=IFCSTRUCTURALLOADSINGLEDISPLACEMENT('D',0.,0.,-0.001,0.,0.,0.);`;

  it('IFC2X3 -> IFC4: leaves out a CausedBy the Causes relationship brings back, and reports one it does not', async () => {
    // #22 is caused by #20 alone. #23 is caused by #20, but a source Causes relationship
    // already names #21 for it, so IFC4 holds two causes and IFC2X3 CausedBy cannot come back.
    const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R1',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALPOINTREACTION('1KQ0efL39PrP5DeqBwaUNp',#5,'R2',$,$,#9,$,#12,.GLOBAL_COORDS.);
#22=IFCSTRUCTURALPOINTACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20);
#23=IFCSTRUCTURALPOINTACTION('3CpCw3$DzVlut_KQsd7u6Y',#5,'B',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20);
#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#21),$,#23);`);
    expect(await losses(ifc2x3, 'IFC2X3', 'IFC4')).toEqual([{ type: 'IFCSTRUCTURALPOINTACTION', ids: [23], lost: ['CausedBy'] }]);
    const back = await roundTrip(ifc2x3, 'IFC2X3', 'IFC4');
    expect(line(back, 22)).toMatch(/,\.F\.,#20\);$/);
    expect(line(back, 23)).toMatch(/,\.F\.,\$\);$/);
  });

  it('IFC2X3 -> IFC4: leaves out varying thicknesses the property set brings back, and reports them when the location is no point aspect', async () => {
    const ifc2x3 = (aspectItem: string) => model('IFC2X3', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(${aspectItem}));
#17=IFCSHAPEASPECT((#16),'Thickness locations',$,.T.,#15);
#18=IFCPOLYLINE((#7,#7));
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);`);
    expect(await losses(ifc2x3('#7'), 'IFC2X3', 'IFC4')).toEqual([]);
    expect(line(await roundTrip(ifc2x3('#7'), 'IFC2X3', 'IFC4'), 20)).toMatch(/,\.SHELL\.,0\.2,\(0\.25,0\.3\),#17\);$/);
    expect(await losses(ifc2x3('#18'), 'IFC2X3', 'IFC4')).toEqual([
      { type: 'IFCSTRUCTURALSURFACEMEMBERVARYING', ids: [20], lost: ['SubsequentThickness', 'VaryingThicknessLocation'] },
    ]);
    expect(line(await roundTrip(ifc2x3('#18'), 'IFC2X3', 'IFC4'), 20)).not.toContain('(0.25,0.3)');
  });

  it('IFC4 -> IFC2X3: leaves out SelfWeightCoefficients the property set brings back, and reports a malformed list', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));
#21=IFCSTRUCTURALLOADCASE('2gUSy$VNbHyPCNtxi3Mz27',#5,'Bad',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,-1.));`);
    expect(await losses(ifc4, 'IFC4', 'IFC2X3')).toEqual([{ type: 'IFCSTRUCTURALLOADCASE', ids: [21], lost: ['SelfWeightCoefficients'] }]);
    const back = await roundTrip(ifc4, 'IFC4', 'IFC2X3');
    expect(line(back, 20)).toMatch(/^#20=IFCSTRUCTURALLOADCASE\(.*,\(0\.,0\.,-1\.\)\);$/);
    expect(line(back, 21)).toMatch(/^#21=IFCSTRUCTURALLOADGROUP\(/);
  });

  it('IFC4 -> IFC2X3: leaves out a SharedPlacement the upgrade derives from the items, and reports one it cannot', async () => {
    const ifc4 = (connectionPlacement: string) => model('IFC4', `${OWNER}
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#9,$,.RIGID_JOINED_MEMBER.,$);
#21=IFCSTRUCTURALPOINTCONNECTION('1IIB7Cy$HI3REa9CT8boqX',#5,'N',$,$,${connectionPlacement},$,$,$);
#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#9);
#31=IFCRELASSIGNSTOGROUP('1rjQw6HYfMHPFWRTOSlRaA',#5,$,$,(#20,#21),$,#30);`);
    // The members lose Axis and ConditionCoordinateSystem of their own; only the model is asked about.
    const modelLosses = async (text: string) => (await losses(text, 'IFC4', 'IFC2X3')).filter((e) => e.type === 'IFCSTRUCTURALANALYSISMODEL');
    expect(await modelLosses(ifc4('#9'))).toEqual([]);
    expect(line(await roundTrip(ifc4('#9'), 'IFC4', 'IFC2X3'), 30)).toMatch(/,\$,#9\);$/);
    // #10 is a different placement, so the items share none.
    expect(await modelLosses(ifc4('#10'))).toEqual([{ type: 'IFCSTRUCTURALANALYSISMODEL', ids: [30], lost: ['SharedPlacement'] }]);
    expect(line(await roundTrip(ifc4('#10'), 'IFC4', 'IFC2X3'), 30)).toMatch(/,\$,\$\);$/);
    // #10597: a grouping listing a non-reference leaves the model's items unknown, so the upgrade derives no SharedPlacement.
    const unread = ifc4('#9').replace('(#20,#21),$,#30', '(#20,#21,$),$,#30');
    expect(await modelLosses(unread)).toEqual([{ type: 'IFCSTRUCTURALANALYSISMODEL', ids: [30], lost: ['SharedPlacement'] }]);
  });

  it('IFC4 -> IFC2X3: leaves out the load configuration Values and a NOTDEFINED PredefinedType the varying action brings back', async () => {
    const ifc4 = (predefined: string) => model('IFC4', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCVERTEXPOINT(#7);
#15=IFCTOPOLOGYREPRESENTATION(#13,'Reference','Vertex',(#14));
#16=IFCPRODUCTDEFINITIONSHAPE($,$,(#15));
#17=IFCSHAPEASPECT((#15,#15),$,$,.U.,#16);
#18=IFCSTRUCTURALLOADLINEARFORCE('start',0.,0.,-5.,0.,0.,0.);
#19=IFCSTRUCTURALLOADLINEARFORCE('end',0.,0.,-9.,0.,0.,0.);
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#18,#19),$);
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',#5,'Line',$,$,$,#16,#25,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,${predefined});`);
    expect(await losses(ifc4('.NOTDEFINED.'), 'IFC4', 'IFC2X3')).toEqual([
      { type: 'IFCSTRUCTURALLOADCONFIGURATION', ids: [25], lost: ['Name', 'Locations'] },
    ]);
    expect(line(await roundTrip(ifc4('.NOTDEFINED.'), 'IFC4', 'IFC2X3'), 30)).toMatch(/,#16,#(\d+),\.GLOBAL_COORDS\.,\.F\.,\.TRUE_LENGTH\.,\.NOTDEFINED\.\);$/);
    expect(await roundTrip(ifc4('.NOTDEFINED.'), 'IFC4', 'IFC2X3')).toContain('=IFCSTRUCTURALLOADCONFIGURATION($,(#18,#19),$);');
    const mixed = ifc4('.NOTDEFINED.').replace('ENDSEC;\nEND-ISO', '#26=IFCSTRUCTURALLOADCONFIGURATION($,(#18,#19),$);\nENDSEC;\nEND-ISO');
    const report = analyzeConversionLoss(await parse(mixed), 'IFC4', 'IFC2X3');
    const configurations = report.entries.filter((entry) => entry.sourceType === 'IFCSTRUCTURALLOADCONFIGURATION');
    expect(configurations).toMatchObject([{
      count: 2,
      expressIds: [25, 26],
      droppedAttributes: ['Name', 'Values', 'Locations'],
      recordGroups: [
        { expressIds: [25], droppedAttributes: ['Name', 'Locations'] },
        { expressIds: [26], droppedAttributes: ['Name', 'Values', 'Locations'] },
      ],
    }]);
    // A LINEAR action comes back NOTDEFINED.
    expect(await losses(ifc4('.LINEAR.'), 'IFC4', 'IFC2X3')).toEqual([
      { type: 'IFCSTRUCTURALCURVEACTION', ids: [30], lost: ['PredefinedType'] },
      { type: 'IFCSTRUCTURALLOADCONFIGURATION', ids: [25], lost: ['Name', 'Locations'] },
    ]);
    expect(line(await roundTrip(ifc4('.LINEAR.'), 'IFC4', 'IFC2X3'), 30)).toMatch(/,\.NOTDEFINED\.\);$/);
  });

  it('omits Axis when the IFC2X3 profile association restores it (#9668)', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#9,$,.RIGID_JOINED_MEMBER.,#21);
#21=IFCDIRECTION((0.,1.,0.));`);
    expect(await losses(ifc4, 'IFC4', 'IFC2X3')).toEqual([]);
    expect(line(await roundTrip(ifc4, 'IFC4', 'IFC2X3'), 20)).toMatch(/,#21\);$/);
  });

  it('returns schema losses when evaluating the structural carriers fails (#9668)', async () => {
    const store = await parse(model('IFC4', `${OWNER}
#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));`));
    const read = vi.spyOn(store.entityIndex.byId, 'get').mockImplementationOnce(() => {
      throw new Error('source record is unavailable');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(analyzeConversionLoss(store, 'IFC4', 'IFC2X3').entries).toContainEqual(expect.objectContaining({
        sourceType: 'IFCSTRUCTURALLOADCASE',
        expressIds: [20],
        droppedAttributes: ['SelfWeightCoefficients'],
      }));
    } finally {
      read.mockRestore();
      warning.mockRestore();
    }
  });

  it('leaves the report as it was for a store without source bytes', () => {
    const store = { entityIndex: { byType: new Map([['IFCSTRUCTURALLOADCASE', [20]]]), byId: new Map() as never } };
    expect(analyzeConversionLoss(store, 'IFC4', 'IFC2X3').entries).toMatchObject([{ sourceType: 'IFCSTRUCTURALLOADCASE', droppedAttributes: ['SelfWeightCoefficients'] }]);
  });
});
