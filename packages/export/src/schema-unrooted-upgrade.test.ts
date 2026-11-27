/* SPDX-License-Identifier: MPL-2.0 */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { MergedExporter } from './merged-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';
import { StepExporter } from './step-exporter.js';

it('prunes references to removed IFC2X3 resources using IFC4 slot cardinality (#10970)', async () => {
  const raw = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_upgrade.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(raw).buffer);
  const single = new StepExporter(store).export({ schema: 'IFC4' });
  const merged = new MergedExporter([{ id: 'source', name: 'source', dataStore: store }]);
  const options = { schema: 'IFC4', projectStrategy: 'keep-first' } as const;
  for (const result of [single, merged.export(options), await merged.exportAsync(options)]) {
    const out = new TextDecoder().decode(result.content);
    expect(out).not.toMatch(/^#(?:3|6|7|19|21|22)=/m);
    expect(out).toContain('#4=IFCGEOMETRICCURVESET((#5));');
    expect(out).toContain('#13=IFCGEOMETRICCURVESET((#5));');
    expect(out).toContain("#12=IFCSTYLEDITEM($,(#11),'keep #3 as text');");
    expect(out).toContain('#17=IFCCURVEBOUNDEDPLANE(#16,#5,());');
    expect(result.stats.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('#3 (IFCBEZIERCURVE) was omitted'),
      expect.stringContaining('#21 (IFCCOMPOSITEPROFILEDEF) was omitted'),
      expect.stringContaining('#22 (IFCRELAXATION) was omitted'), // #11131
    ]));
  }
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4');
  expect(report.describe()).toContain('1 × IFCBEZIERCURVE (#3) will be omitted because IFC4 does not declare its type.');
  expect(report.describe()).toContain('1 × IFCCRANERAILASHAPEPROFILEDEF (#19) will be omitted because IFC4 does not declare its type.');
  expect(report.describe()).toContain('1 × IFCRELAXATION (#22) will be omitted because IFC4 does not declare its type.');
  const cascaded = [['IFCCOMPOSITECURVESEGMENT', 6], ['IFCCOMPOSITECURVE', 7], ['IFCCOMPOSITEPROFILEDEF', 21]] as const;
  for (const [type, id] of cascaded) {
    expect(report.entries.find(entry => entry.sourceType === type)).toMatchObject({ kind: 'lossy', expressIds: [id] });
    expect(report.describe()).toContain(`1 × ${type} (#${id}) will be omitted because a required IFC4 attribute lost a reference.`);
  }
  const typeOnly = analyzeConversionLoss({ entityIndex: store.entityIndex }, 'IFC2X3', 'IFC4');
  expect(typeOnly.entries.some(entry => entry.sourceType === 'IFCCOMPOSITEPROFILEDEF')).toBe(false);
});

it('reports populated task losses alongside cascaded omissions (#11326, #10970)', async () => {
  const store = await parse(envelope([
    '#1=IFCBEZIERCURVE(1,(#2,#3),.UNSPECIFIED.,.F.,.F.);',
    '#2=IFCCARTESIANPOINT((0.,0.));',
    '#3=IFCCARTESIANPOINT((1.,1.));',
    '#4=IFCGEOMETRICCURVESET((#1));',
    "#5=IFCORDERACTION('0EvctVUKr0kugbFTf53O95',$,'O',$,$,'T',$,$,.F.,1,/* unset */$);",
    "#6=IFCORDERACTION('0EvctVUKr0kugbFTf53O96',$,'O',$,$,'T',$,$,.F.,1,'A');",
  ].join('\n')));
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4');
  expect(report.describe()).toContain('1 × IFCGEOMETRICCURVESET (#4) will be omitted because a required IFC4 attribute lost a reference.');
  expect(report.entries.find(e => e.sourceType === 'IFCORDERACTION')).toMatchObject({
    droppedAttributes: ['ActionID'], expressIds: [6], count: 1,
  });
  const { content } = new StepExporter(store).export({ schema: 'IFC4' });
  const output = new TextDecoder().decode(content);
  expect(output).not.toMatch(/^#(?:1|4)=/m);
  expect(output).toMatch(/^#5=IFCTASK\(/m);
  expect(output).toMatch(/^#6=IFCTASK\(/m);
});

it('clears an optional Representation on an unconverted varying action (#10970)', async () => {
  const raw = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_legacy_optional.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(raw).buffer);
  const merged = new MergedExporter([{ id: 'source', name: 'source', dataStore: store }]);
  const options = { schema: 'IFC4' } as const;
  for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
    const output = new TextDecoder().decode(result.content);
    expect(output).toContain("#30=IFCSTRUCTURALLINEARACTIONVARYING('3sXjCM_kPHN8ZCpuBhV_98',$,'A',$,$,$,$,#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,$);");
    expect(output).not.toMatch(/^#(?:41|42|43)=/m);
    expect(result.stats.warnings.some(warning => warning.includes('#30 (IFCSTRUCTURALLINEARACTIONVARYING) was omitted'))).toBe(false);
  }
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4');
  expect(report.entries.find(entry => entry.sourceType === 'IFCPRODUCTDEFINITIONSHAPE')?.expressIds).toEqual([43]);
  expect(report.describe().some(line => line.includes('IFCSTRUCTURALLINEARACTIONVARYING (#30) will be omitted'))).toBe(false);
});

const envelope = (records: string) => "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n" + records + "\nENDSEC;\nEND-ISO-10303-21;";
const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);

it('prunes remapped records and repairs references above the source ID bound (#10970)', async () => {
  const first = await parse(envelope('#4294967295=IFCCARTESIANPOINT((0.,0.));'));
  const second = await parse(envelope([
    '#1=IFCBEZIERCURVE(1,(#2,#3),.UNSPECIFIED.,.F.,.F.);',
    '#2=IFCCARTESIANPOINT((0.,0.));',
    '#3=IFCCARTESIANPOINT((1.,1.));',
    '#4=IFCPOLYLINE((#2,#3));',
    '#5=IFCGEOMETRICCURVESET((#1,#4));',
  ].join('\n')));
  const merged = new MergedExporter([
    { id: 'first', name: 'first', dataStore: first },
    { id: 'second', name: 'second', dataStore: second },
  ]);
  const options = { schema: 'IFC4' } as const;
  for (const result of [merged.export(options), await merged.exportAsync(options)]) {
    const output = new TextDecoder().decode(result.content);
    expect(output).not.toContain('#4294967296=');
    expect(output).toContain('#4294967300=IFCGEOMETRICCURVESET((#4294967299));');
    expect(result.stats.warnings).toContainEqual(expect.stringContaining('#4294967296 (IFCBEZIERCURVE) was omitted'));
  }
  const invalidSource = await parse(envelope('#1=IFCGEOMETRICCURVESET((#4294967296));'));
  const invalid = new MergedExporter([
    { id: 'first', name: 'first', dataStore: first },
    { id: 'invalid', name: 'invalid', dataStore: invalidSource },
  ]);
  expect(() => invalid.export(options)).toThrow('invalid STEP argument list');
  await expect(invalid.exportAsync(options)).rejects.toThrow('invalid STEP argument list');
});

it('previews a convertible varying action after projecting out its pruned location (#10970)', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../rust/export/tests/fixtures/structural_carriers_parity.json', import.meta.url), 'utf8')) as {
    owner: string; cases: { why: string; data: string }[];
  };
  const action = fixture.cases.find(({ why }) => why.startsWith('a converted varying action:'))!;
  const source = fixture.owner + '\n' + action.data.replaceAll("'Point',(#7)", "'Edge',(#41)")
    + '\n#41=IFCBEZIERCURVE(1,(#7,#7),.UNSPECIFIED.,.F.,.F.);';
  const store = await parse(envelope(source));
  const { content } = new StepExporter(store).export({ schema: 'IFC4' });
  const output = new TextDecoder().decode(content);
  expect(output).toMatch(/^#30=IFCSTRUCTURALCURVEACTION\([^\n]+,#9,\$,#[0-9]+,/m);
  expect(output).toContain('IFCSTRUCTURALLOADCONFIGURATION($,(#11,#19,#18),$);');
  expect(output).not.toMatch(/^#(?:15|17|41)=/m);
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4');
  expect(report.entries.find(entry => entry.sourceType === 'IFCSHAPEASPECT')?.expressIds).toContain(17);
  expect(report.describe().some(line => line.includes('IFCSTRUCTURALLINEARACTIONVARYING (#30) will be omitted'))).toBe(false);
});

it('counts only surviving creations alongside a source omission and generated varying records (#10970)', async () => {
  const source = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_legacy_optional.ifc', import.meta.url), 'utf8');
  const store = await parse(source.replace('#30=', "#18=IFCSTRUCTURALLOADLINEARFORCE('additional',0.,0.,-6.,0.,0.,0.);\n"
    + "#19=IFCSTRUCTURALLOADLINEARFORCE('additional',0.,0.,-7.,0.,0.,0.);\n"
    + "#16=IFCSHAPEASPECT((#42,#42,#42),$,$,.T.,#43);\n#30=").replace('#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,$,$);',
      '#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,#16,(#18,#19));'));
  const view = new MutablePropertyView(store.properties, 'pruning');
  view.setExpressIdWatermark(43);
  const removed = view.createEntity('IfcRelaxation', [0.1, 0.5]).expressId;
  const kept = view.createEntity('IfcCartesianPoint', [[2, 3]]).expressId;
  const result = new StepExporter(store, view).export({ schema: 'IFC4' });
  const output = new TextDecoder().decode(result.content);
  expect(output).not.toContain(`#${removed}=`);
  expect(output).not.toMatch(/^#41=/m);
  expect(output).toContain(`#${kept}=IFCCARTESIANPOINT(`);
  expect(output).toContain(`#${kept + 1}=IFCSTRUCTURALLOADCONFIGURATION(`);
  expect(result.stats.newEntityCount).toBe(2);
  expect(output).toContain('2 modifications');
});

it('keeps the header free of added records when the only creation is pruned (#10970)', async () => {
  const store = await parse(envelope('#1=IFCCARTESIANPOINT((0.,0.));'));
  const view = new MutablePropertyView(store.properties, 'pruning');
  view.setExpressIdWatermark(1);
  const removed = view.createEntity('IfcRelaxation', [0.1, 0.5]).expressId;
  const result = await new StepExporter(store, view).exportAsync({ schema: 'IFC4' });
  const output = new TextDecoder().decode(result.content);
  expect(output).not.toContain(`#${removed}=`);
  expect(result.stats.newEntityCount).toBe(0);
  expect(output).not.toContain('Re-exported by ifc-lite');
});

it('retains typed properties and user-defined labels with remapped references above u32 (#10970)', async () => {
  const first = await parse(envelope('#4294967295=IFCCARTESIANPOINT((0.,0.));'));
  const second = await parse(envelope([
    "#1=IFCMATERIAL('steel');",
    '#2=IFCGENERALMATERIALPROPERTIES(#1,$,$,42.);',
    "#3=IFCPERSON($,'P',$,$,$,$,$,$);",
    "#4=IFCORGANIZATION($,'O',$,$,$);",
    '#5=IFCPERSONANDORGANIZATION(#3,#4,$);',
    "#6=IFCAPPLICATION(#4,'1','A','A');",
    '#7=IFCOWNERHISTORY(#5,#6,$,.NOCHANGE.,$,$,$,1);',
    "#8=IFCPROCEDURE('3sXjCM_kPHN8ZCpuBhV_98',#7,'P',$,$,'P-1',.USERDEFINED.,'Flush');",
    '#9=IFCCALENDARDATE(29,2,2024);',
    "#10=IFCCLASSIFICATION('src','1',#9,'name');",
  ].join('\n')));
  const merged = new MergedExporter([
    { id: 'first', name: 'first', dataStore: first },
    { id: 'second', name: 'second', dataStore: second },
  ]);
  const options = { schema: 'IFC4' } as const;
  for (const result of [merged.export(options), await merged.exportAsync(options)]) {
    const out = new TextDecoder().decode(result.content);
    expect.soft(out).toMatch(/^#4294967297=IFCMATERIALPROPERTIES\([^\n]+,\(#4294967306\),#4294967296\);$/m);
    expect.soft(out).toContain("#4294967306=IFCPROPERTYSINGLEVALUE('MassDensity',$,IFCMASSDENSITYMEASURE(42.),$);");
    expect.soft(out).toContain("#4294967305=IFCCLASSIFICATION('src','1','2024-02-29','name',$,$,$);");
    expect.soft(out).toContain("#4294967303=IFCPROCEDURE('3sXjCM_kPHN8ZCpuBhV_98',#4294967302,'P',$,'Flush','P-1',$,.USERDEFINED.);");
  }
});

it('withholds a sectioned spine that loses a section and preserves its neighbour (#10970)', async () => {
  const text = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_spine.ifc', import.meta.url), 'utf8');
  const store = await parse(text);
  const options = { schema: 'IFC4' } as const;
  const merged = new MergedExporter([{ id: 'source', name: 'source', dataStore: store }]);
  for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
    const out = new TextDecoder().decode(result.content);
    expect(out).not.toMatch(/^#(?:13|16)=/m);
    expect(out).toContain('#17=IFCSECTIONEDSPINE(#6,(#12,#15,#14),(#7,#8,#9));');
    expect(result.stats.warnings).toContainEqual(expect.stringContaining('#16 (IFCSECTIONEDSPINE) was omitted'));
  }
  expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC4').entries.find(e => e.sourceType === 'IFCSECTIONEDSPINE')?.expressIds).toEqual([16]);
});

it('reconciles a value form beside a remapped unit reference above u32 (#10970)', async () => {
  const first = await parse(envelope('#4294967295=IFCCARTESIANPOINT((0.,0.));'));
  const second = await parse(envelope(
    '#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n#2=IFCPROPERTYSINGLEVALUE(\'n\',$,IFCBINARY("0A"),#1);',
  ).replace("('IFC2X3')", "('IFC4X3_ADD2')"));
  const merged = new MergedExporter([
    { id: 'first', name: 'first', dataStore: first },
    { id: 'second', name: 'second', dataStore: second },
  ]);
  const opts = { schema: 'IFC2X3', projectStrategy: 'keep-first' } as const;
  for (const result of [merged.export(opts), await merged.exportAsync(opts)]) {
    expect(new TextDecoder().decode(result.content)).toContain("#4294967297=IFCPROPERTYSINGLEVALUE('n',$,$,#4294967296);");
    expect(result.stats.warnings).toContainEqual(expect.stringContaining('IFCPROPERTYSINGLEVALUE.NominalValue'));
  }
});

it('reports only the trimmed curve whose required basis is omitted in IFC4X3 (#10971)', async () => {
  const raw = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_unrooted_upgrade.ifc', import.meta.url), 'utf8');
  const source = raw.replace('ENDSEC;\nEND-ISO',
    '#32=IFCTRIMMEDCURVE(#3,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);\n'
    + '#33=IFCTRIMMEDCURVE(#36,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.)),.T.,.PARAMETER.);\n'
    + '#34=IFCDIRECTION((1.,0.));\n#35=IFCVECTOR(#34,1.);\n#36=IFCLINE(#1,#35);\nENDSEC;\nEND-ISO');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
  const out = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4X3' }).content);
  expect(out).not.toMatch(/^#(?:3|6|7|32)=/m);
  expect(out).toMatch(/^#33=IFCTRIMMEDCURVE/m);
  const report = analyzeConversionLoss(store, 'IFC2X3', 'IFC4X3');
  expect(report.entries.find(entry => entry.sourceType === 'IFCTRIMMEDCURVE')).toMatchObject({ kind: 'lossy', expressIds: [32] });
  expect(report.entries.find(entry => entry.sourceType === 'IFCCOMPOSITECURVE')).toMatchObject({ kind: 'lossy', expressIds: [7] });
  expect(report.describe()).toContain('1 × IFCTRIMMEDCURVE (#32) will be omitted because a required IFC4X3 attribute lost a reference.');
  const sourceOnly = analyzeConversionLoss({ entityIndex: store.entityIndex }, 'IFC2X3', 'IFC4X3');
  expect(sourceOnly.entries.find(entry => entry.sourceType === 'IFCTRIMMEDCURVE')).toBeUndefined();
});

it('clears only the optional Zone of a retained IFC2X3 local time in IFC4X3 (#10971)', async () => {
  // A damaged HourOffset refers to an obsolete curve, so the offset is pruned.
  const raw = readFileSync(new URL('../../../rust/export/tests/fixtures/schema_ifc4x3_legacy_optional.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(Uint8Array.from(raw).buffer);
  const merged = new MergedExporter([{ id: 'source', name: 'source', dataStore: store }]);
  const options = { schema: 'IFC4X3' } as const;
  for (const result of [new StepExporter(store).export(options), merged.export(options), await merged.exportAsync(options)]) {
    const output = new TextDecoder().decode(result.content);
    expect(output).toContain('#5=IFCLOCALTIME(10,30,15.,$,$);');
    expect(output).toContain('#7=IFCDATEANDTIME(#6,#5);');
    expect(output).not.toMatch(/^#(?:3|4)=/m);
    expect(result.stats.warnings).toContainEqual(expect.stringContaining('#4 (IFCCOORDINATEDUNIVERSALTIMEOFFSET) was omitted'));
    expect(result.stats.warnings).not.toContainEqual(expect.stringContaining('#5 (IFCLOCALTIME) was omitted'));
  }
  const description = analyzeConversionLoss(store, 'IFC2X3', 'IFC4X3').describe().join('\n');
  expect(description).toContain('IFCCOORDINATEDUNIVERSALTIMEOFFSET (#4) will be omitted');
  expect(description).not.toContain('IFCLOCALTIME (#5) will be omitted');
  expect(description).not.toContain('IFCDATEANDTIME (#7) will be omitted');
});
