/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;

const OWNER = `#1=IFCPERSON($,'P',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'O',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','A','A');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1);
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'P',$,$,$,$,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT($,#8);
#11=IFCSTRUCTURALLOADLINEARFORCE('line',0.,0.,-5.,0.,0.,0.);
#12=IFCSTRUCTURALLOADSINGLEDISPLACEMENT('disp',0.,0.,-0.001,0.,0.,0.);`;

const CASES = [
  {
    carried: 'IFCSTRUCTURALLINEARACTION.CausedBy',
    from: 'IFC2X3',
    to: 'IFC4',
    data: `#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.);`,
  },
  {
    carried: 'IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness',
    from: 'IFC2X3',
    to: 'IFC4',
    data: `#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),'Thickness locations',$,.T.,#15);
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);`,
  },
  {
    carried: 'IFCSTRUCTURALLOADCASE.SelfWeightCoefficients',
    from: 'IFC4',
    to: 'IFC2X3',
    data: `#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));`,
  },
] as const;

async function previewAndExport(from: 'IFC2X3' | 'IFC4', to: 'IFC2X3' | 'IFC4', data: string) {
  const text = model(from, `${OWNER}\n${data}`);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
  const report = analyzeConversionLoss(store, from, to);
  const warnings = new StepExporter(store).export({ schema: to }).stats.warnings.join('\n');
  const previewed = report.entries.flatMap((e) => e.droppedAttributes.map((a) => `${e.sourceType}.${a}`));
  return { previewed, warnings };
}

// #10597: the preview names an attribute lost exactly when the export does.
describe('conversion loss report and structural carriers #10597', () => {
  it.each(CASES)('does not report $carried lost, as the export keeps it', async ({ carried, from, to, data }) => {
    const { previewed, warnings } = await previewAndExport(from, to, data);
    expect(warnings).not.toContain(`${carried} has no slot`);
    expect(previewed).not.toContain(carried);
  });

  it('still reports SharedPlacement lost into IFC2X3, as the export does', async () => {
    const { previewed, warnings } = await previewAndExport('IFC4', 'IFC2X3', `#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#9,$,.RIGID_JOINED_MEMBER.,$);
#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#9);
#31=IFCRELASSIGNSTOGROUP('1rjQw6HYfMHPFWRTOSlRaA',#5,$,$,(#20),$,#30);`);
    expect(warnings).toContain('IFCSTRUCTURALANALYSISMODEL.SharedPlacement has no slot in IFC2X3');
    expect(previewed).toContain('IFCSTRUCTURALANALYSISMODEL.SharedPlacement');
  });
});
