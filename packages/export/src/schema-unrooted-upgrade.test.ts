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
