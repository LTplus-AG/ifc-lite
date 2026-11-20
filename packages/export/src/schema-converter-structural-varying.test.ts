/* SPDX-License-Identifier: MPL-2.0 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const line = (step: string, id: number): string | undefined => step.split('\n').find((l) => l.startsWith(`#${id}=`));
const records = (step: string, type: string): string[] => step.split('\n').filter((l) => new RegExp(`^#\\d+=${type}\\(`).test(l));

// Each action's IfcShapeAspect names the action's own IfcProductDefinitionShape,
// as in structural/ifc_structuralanalysisview/steel-joint-modelled-with-shellelements--Axis-Struc.ifc.
const SHARED = `#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,$,$);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCVERTEXPOINT(#3);
#6=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#7=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#8=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#9=IFCTOPOLOGYREPRESENTATION(#2,'Reference','Vertex',(#5));
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#11=IFCSHAPEASPECT((#7,#8),$,$,.U.,#10);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#13=IFCSHAPEASPECT((#7,#8,#9),$,$,.U.,#12);
#20=IFCSTRUCTURALLOADLINEARFORCE('start',0.,0.,-5.,0.,0.,0.);
#21=IFCSTRUCTURALLOADLINEARFORCE('end',0.,0.,-9.,0.,0.,0.);
#22=IFCSTRUCTURALLOADPLANARFORCE('a',0.,0.,-1.);
#23=IFCSTRUCTURALLOADPLANARFORCE('b',0.,0.,-2.);
#24=IFCSTRUCTURALLOADPLANARFORCE('c',0.,0.,-3.);`;

const IFC2X3 = model('IFC2X3', `${SHARED}
#30=IFCSTRUCTURALLINEARACTIONVARYING('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,.PROJECTED_LENGTH.,#11,(#21));
#31=IFCSTRUCTURALPLANARACTIONVARYING('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#22,.GLOBAL_COORDS.,.T.,$,.TRUE_LENGTH.,#13,(#23,#24));`);

// #9668: IFC4 has no varying actions. It holds the loads in an
// IfcStructuralLoadConfiguration on a curve or surface action.
describe('varying structural actions IFC2X3 <-> IFC4 #9668', () => {
  it('refuses a shared configuration even when the SINUS referrer has a comment before its arguments (#10715)', async () => {
    const source = model('IFC4', `${SHARED}
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.LINEAR.);
#31=IFCSTRUCTURALCURVEACTION/* (' */('1d2HL$ILbNDhwyUI0qw12$',$,'Sinus',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.SINUS.);`);
    const awaitedStore = await parse(source);
    expect(() => exportToStep(awaitedStore, { schema: 'IFC2X3' })).toThrow(/IFCSTRUCTURALLOADCONFIGURATION shared/);
  });

  it('converts a split-line varying action and withholds its split-line configuration (#10715)', async () => {
    const config = '#25=IFCSTRUCTURALLOADCONFIGURATION($,\n  (#20,#21),$);';
    const action = "#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,\n  .GLOBAL_COORDS.,.F.,$,.LINEAR.);";
    const store = await parse(model('IFC4', `${SHARED}\n${config}\n${action}`));
    const exported = exportToStep(store, { schema: 'IFC2X3' });
    expect(exported).toMatch(/^#30=IFCSTRUCTURALLINEARACTIONVARYING\([^;]*,#20,[^;]*,#11,\(#21\)\);$/m);
    expect(exported).not.toContain('#25');
    const configuration = analyzeConversionLoss(store, 'IFC4', 'IFC2X3')
      .entries.find((entry) => entry.sourceType === 'IFCSTRUCTURALLOADCONFIGURATION');
    expect(configuration?.droppedAttributes).toEqual(['Name', 'Locations']);
  });

  it('requires one aspect representation per load in both directions (B)', async () => {
    const validIfc4 = exportToStep(await parse(IFC2X3), { schema: 'IFC4' });
    for (const [representations, replacement, id] of [
      ['(#7,#8)', '(#7)', 30], ['(#7,#8)', '(#7,#8,#9)', 30],
      ['(#7,#8,#9)', '(#7,#8)', 31], ['(#7,#8,#9)', '(#7,#8,#9,#6)', 31],
    ] as const) {
      const change = (source: string) => source.replace(`IFCSHAPEASPECT(${representations},`, `IFCSHAPEASPECT(${replacement},`);
      const upgraded = exportToStep(await parse(change(IFC2X3)), { schema: 'IFC4' });
      expect(line(upgraded, id)).toContain(id === 30 ? '=IFCSTRUCTURALLINEARACTIONVARYING(' : '=IFCSTRUCTURALPLANARACTIONVARYING(');
      const downgraded = exportToStep(await parse(change(validIfc4)), { schema: 'IFC2X3' });
      expect(line(downgraded, id)).toMatch(new RegExp(`^#${id}=IFCPROXY\\(`));
    }
  });

  it('writes an IFC2X3 varying action as an IFC4 action with a load configuration', async () => {
    const result = new StepExporter(await parse(IFC2X3)).export({ schema: 'IFC4' });
    const ifc4 = new TextDecoder().decode(result.content);
    // The ids after the source's highest, #31, in source order, as the Rust writers write them.
    expect(line(ifc4, 30)).toBe("#30=IFCSTRUCTURALCURVEACTION('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#32,.GLOBAL_COORDS.,.F.,.PROJECTED_LENGTH.,.NOTDEFINED.);");
    expect(line(ifc4, 31)).toBe("#31=IFCSTRUCTURALSURFACEACTION('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#33,.GLOBAL_COORDS.,.T.,.TRUE_LENGTH.,.NOTDEFINED.);");
    expect(records(ifc4, 'IFCSTRUCTURALLOADCONFIGURATION')).toEqual(['#32=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);', '#33=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);']);
    expect(result.stats.warnings.join('\n')).toContain('2 structural conversion record(s): an IFC2X3 varying action is written as an IFC4 curve or surface action');
  });

  it('round trips both varying actions through IFC4', async () => {
    const ifc4 = exportToStep(await parse(IFC2X3), { schema: 'IFC4' });
    const result = new StepExporter(await parse(ifc4)).export({ schema: 'IFC2X3' });
    const back = new TextDecoder().decode(result.content);
    expect(line(back, 30)).toBe("#30=IFCSTRUCTURALLINEARACTIONVARYING('3AqvQc$eTFwQAT_AXxIZSF',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,.PROJECTED_LENGTH.,#11,(#21));");
    expect(line(back, 31)).toBe("#31=IFCSTRUCTURALPLANARACTIONVARYING('1uiQrU6X9TmxEpF_G_jsDX',$,'Area',$,$,$,#12,#22,.GLOBAL_COORDS.,.T.,$,.TRUE_LENGTH.,#13,(#23,#24));");
    expect(records(back, 'IFCSTRUCTURALLOADCONFIGURATION')).toEqual([]);
    expect(result.stats.warnings.join('\n')).toContain('2 structural conversion record(s): an IFC4 curve or surface action with an IfcStructuralLoadConfiguration is written as an IFC2X3 varying action');
  });

  it('writes the CausedBy of a varying action as a Causes relationship', async () => {
    const withReaction = IFC2X3.replace(',.F.,$,.PROJECTED_LENGTH.', ',.F.,#40,.PROJECTED_LENGTH.')
      .replace('#30=', "#40=IFCSTRUCTURALPOINTREACTION('2wmGMbnLPTYekiqaYJVorK',$,$,$,$,$,$,#20,.GLOBAL_COORDS.);\n#30=");
    const result = new StepExporter(await parse(withReaction)).export({ schema: 'IFC4' });
    expect(result.stats.warnings.join('\n')).toContain("IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes'");
    expect(records(new TextDecoder().decode(result.content), 'IFCRELASSIGNSTOPRODUCT')).toEqual([expect.stringMatching(/'Causes',\$,\(#40\),\$,#30\);$/)]);
  });

  it('reports an unknown DestabilizingLoad and refuses loads of mixed types', async () => {
    // ProjectedOrTrue has no IFC2X3 default, so it stays `$` and the slot fill reports it, as for a constant action.
    const ifc4 = model('IFC4', `${SHARED}
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);
#26=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#22),$);
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,$,$,.LINEAR.);
#31=IFCSTRUCTURALCURVEACTION('1d2HL$ILbNDhwyUI0qw12$',$,'Mixed',$,$,$,#12,#26,.GLOBAL_COORDS.,.F.,$,.LINEAR.);`);
    const result = new StepExporter(await parse(ifc4)).export({ schema: 'IFC2X3' });
    const out = new TextDecoder().decode(result.content);
    expect(line(out, 30)).toBe("#30=IFCSTRUCTURALLINEARACTIONVARYING('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#20,.GLOBAL_COORDS.,.F.,$,$,#11,(#21));");
    expect(line(out, 31)).toMatch(/^#31=IFCPROXY\(/);
    expect(result.stats.warnings.join('\n')).toContain('1 structural conversion record(s): IFCSTRUCTURALCURVEACTION.DestabilizingLoad is unknown');
  });

  it('takes only distributions linear between the values', async () => {
    const ifc4 = model('IFC4', `${SHARED}
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),$);
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,#10,#25,.GLOBAL_COORDS.,.F.,$,.SINUS.);`);
    expect(line(exportToStep(await parse(ifc4), { schema: 'IFC2X3' }), 30)).toMatch(/^#30=IFCPROXY\(/);
  });

  it('leaves an IFC4 action with no IfcShapeAspect for its locations as before', async () => {
    const ifc4 = model('IFC4', `${SHARED}
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#20,#21),((0.),(4.)));
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',$,'Line',$,$,$,$,#25,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.LINEAR.);`);
    const out = exportToStep(await parse(ifc4), { schema: 'IFC2X3' });
    expect(line(out, 30)).toMatch(/^#30=IFCPROXY\(/);
  });

  it('does not write a varying action that still names a withheld configuration', async () => {
    // An illegal ObjectPlacement naming the configuration: the rewrite copies it, so the record stays a proxy.
    const ifc4 = exportToStep(await parse(IFC2X3), { schema: 'IFC4' }).replace(/(#30=IFCSTRUCTURALCURVEACTION\('[^']*',\$,'Line',\$,\$,)\$/, '$1#32');
    const result = new StepExporter(await parse(ifc4)).export({ schema: 'IFC2X3' });
    const out = new TextDecoder().decode(result.content);
    expect(line(out, 30)).toMatch(/^#30=IFCPROXY\(/);
    expect(line(out, 31)).toMatch(/^#31=IFCSTRUCTURALPLANARACTIONVARYING\(/);
    expect(result.stats.warnings.join('\n')).toContain('1 structural conversion record(s): an IFC4 curve or surface action');
  });

  it('converts only what converts back: a location aspect elsewhere leaves the action as before', async () => {
    // #13 places #12, not #10, so a downgrade could not find the locations again.
    const out = exportToStep(await parse(IFC2X3.replace(',#11,(#21));', ',#13,(#21));')), { schema: 'IFC4' });
    expect(line(out, 30)).toMatch(/^#30=IFCSTRUCTURALLINEARACTIONVARYING\(/);
    expect(records(out, 'IFCSTRUCTURALLOADCONFIGURATION')).toEqual(['#32=IFCSTRUCTURALLOADCONFIGURATION($,(#22,#23,#24),$);']);
  });

  // The R12 fixture gives one location per load (IFC2X3 VaryingAppliedLoadLocation corresponds by index);
  // before, one location for three loads left both actions unconverted (case B above).
  const coverage = fileURLToPath(new URL('../../../tests/models/ifcopenshell/generated_structural_coverage_ifc2x3.ifc', import.meta.url));
  it.skipIf(!existsSync(coverage))('converts the IFC2X3 coverage fixture varying actions both ways (pnpm fixtures if absent)', async () => {
    const source = new TextDecoder().decode(readFileSync(coverage));
    const ifc4 = exportToStep(await parse(source), { schema: 'IFC4' });
    expect(records(ifc4, 'IFCSTRUCTURAL(LINEAR|PLANAR)ACTIONVARYING')).toEqual([]);
    expect(records(ifc4, 'IFCSTRUCTURALLOADCONFIGURATION')).toHaveLength(2);
    const back = exportToStep(await parse(ifc4), { schema: 'IFC2X3' });
    for (const type of ['IFCSTRUCTURALLINEARACTIONVARYING', 'IFCSTRUCTURALPLANARACTIONVARYING']) {
      expect(records(back, type)).toEqual(records(source, type));
    }
  });

  it('converts a subset that retains the varying action and its load locations (#11037)', async () => {
    const result = new StepExporter(await parse(IFC2X3)).export({ schema: 'IFC4', subsetEntityIds: new Set([1, 10, 11, 20, 21, 30]) });
    const output = new TextDecoder().decode(result.content);
    expect(line(output, 30)).toMatch(/^#30=IFCSTRUCTURALCURVEACTION\(/);
    expect(records(output, 'IFCSTRUCTURALLOADCONFIGURATION')).toEqual([expect.stringContaining('(#20,#21),$);')]);
  });
});
