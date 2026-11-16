/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';
import { LOAD_CASE_PSET } from './schema-converter-structural-carriers.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const line = (step: string, id: number): string | undefined => step.split('\n').find((l) => l.startsWith(`#${id}=`));
const records = (step: string, type: string): string[] => step.split('\n').filter((l) => new RegExp(`^#\\d+=${type}\\(`).test(l));
const convert = async (text: string, schema: 'IFC2X3' | 'IFC4') => {
  const result = new StepExporter(await parse(text)).export({ schema });
  return { step: new TextDecoder().decode(result.content), warnings: result.stats.warnings.join('\n') };
};

const OWNER = `#1=IFCPERSON($,'P',$,$,$,$,$,$);
#2=IFCORGANIZATION($,'O',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1','A','A');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1);
#6=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',#5,'P',$,$,$,$,$,$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCLOCALPLACEMENT($,#8);
#10=IFCLOCALPLACEMENT($,#8);
#11=IFCSTRUCTURALLOADLINEARFORCE('line',0.,0.,-5.,0.,0.,0.);
#12=IFCSTRUCTURALLOADSINGLEDISPLACEMENT('disp',0.,0.,-0.001,0.,0.,0.);`;

// #9668: IFC4 deleted IfcStructuralAction.CausedBy and holds it as an
// IfcRelAssignsToProduct named 'Causes' (IFC4 IfcStructuralAction change note).
describe('CausedBy IFC2X3 <-> IFC4 #9668', () => {
  const IFC2X3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.);
#22=IFCSTRUCTURALLINEARACTION('3nopC4uRTI$9OB7Ig1TJsz',#5,'B',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);`);

  it('writes CausedBy as a Causes relationship and reads it back', async () => {
    const up = await convert(IFC2X3, 'IFC4');
    expect(line(up.step, 21)).toBe("#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);");
    const rels = records(up.step, 'IFCRELASSIGNSTOPRODUCT');
    expect(rels).toHaveLength(1);
    expect(rels[0]).toMatch(/^#\d+=IFCRELASSIGNSTOPRODUCT\('[^']{22}',#5,'Causes',\$,\(#20\),\$,#21\);$/);
    expect(up.warnings).toContain("IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes'");
    expect(up.warnings).not.toContain('CausedBy has no slot in IFC4');

    const down = await convert(up.step, 'IFC2X3');
    // IFC2X3 gives each product its own placement record, so only that slot differs.
    expect(line(down.step, 21)).toMatch(/^#21=IFCSTRUCTURALLINEARACTION\('2CpCw3\$DzVlut_KQsd7u6Y',#5,'A',\$,\$,#\d+,\$,#11,\.GLOBAL_COORDS\.,\.F\.,#20,\.TRUE_LENGTH\.\);$/);
    expect(line(down.step, 22)).toContain(',.F.,$,.TRUE_LENGTH.);');
    // IFC2X3 has the relationship too; it is kept, and a second upgrade does not duplicate it.
    expect(records(down.step, 'IFCRELASSIGNSTOPRODUCT')).toHaveLength(1);
    expect(records((await convert(down.step, 'IFC4')).step, 'IFCRELASSIGNSTOPRODUCT')).toHaveLength(1);
  });

  it('finds a source Causes relationship whatever its RelatedObjectsType, and adds no second one', async () => {
    const withRel = IFC2X3.replace('#22=', "#40=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20),.PRODUCT.,#21);\n#22=");
    expect(records((await convert(withRel, 'IFC4')).step, 'IFCRELASSIGNSTOPRODUCT')).toHaveLength(1);
  });

  it('fills CausedBy only from one relationship naming one point reaction', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#23=IFCSTRUCTURALPOINTREACTION('1KQ0efL39PrP5DeqBwaUNp',#5,'R2',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#22=IFCSTRUCTURALLINEARACTION('3nopC4uRTI$9OB7Ig1TJsz',#5,'B',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#24=IFCSTRUCTURALLINEARACTION('0nopC4uRTI$9OB7Ig1TJsz',#5,'C',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20,#23),$,#21);
#31=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',#5,'Other',$,(#20),$,#22);
#32=IFCRELASSIGNSTOPRODUCT('1ccccccccccccccccccccc',#5,'Causes',$,(#23),$,#24);`);
    const down = await convert(ifc4, 'IFC2X3');
    expect(line(down.step, 21)).toContain(',.F.,$,.TRUE_LENGTH.);');
    expect(line(down.step, 22)).toContain(',.F.,$,.TRUE_LENGTH.);');
    expect(line(down.step, 24)).toContain(',.F.,#23,.TRUE_LENGTH.);');
    expect(records(down.step, 'IFCRELASSIGNSTOPRODUCT')).toHaveLength(3);
  });
});

// #9668: IFC4's IfcStructuralAnalysisModel informal proposition 2: the items
// grouped into it use SharedPlacement as their ObjectPlacement.
describe('IfcStructuralAnalysisModel.SharedPlacement IFC2X3 -> IFC4 #9668', () => {
  const ifc2x3 = (second: string) => model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#9,$,.RIGID_JOINED_MEMBER.);
#21=IFCSTRUCTURALPOINTCONNECTION('1IIB7Cy$HI3REa9CT8boqX',#5,'N',$,$,${second},$,$);
#22=IFCBEAM('1wng2kJ6bGvgWud8Cpi0D9',#5,'Beam',$,$,#10,$,$);
#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$);
#31=IFCRELASSIGNSTOGROUP('1rjQw6HYfMHPFWRTOSlRaA',#5,$,$,(#20,#21,#22),$,#30);`);

  it('writes the placement every grouped item shares', async () => {
    const { step } = await convert(ifc2x3('#9'), 'IFC4');
    expect(line(step, 30)).toBe("#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#9);");
  });

  it('reads equal copies of one local placement as that placement, and places the items by it', async () => {
    const { step } = await convert(ifc2x3('#10'), 'IFC4');
    expect(line(step, 30)).toBe("#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#9);");
    expect(line(step, 21)).toBe("#21=IFCSTRUCTURALPOINTCONNECTION('1IIB7Cy$HI3REa9CT8boqX',#5,'N',$,$,#9,$,$,$);");
    // The beam is not a structural item, so it keeps its own placement.
    expect(line(step, 22)).toContain(",'Beam',$,$,#10,");
  });

  it('leaves it unset when the items use different placements', async () => {
    const { step } = await convert(ifc2x3('#13').replace('#12=', '#13=IFCLOCALPLACEMENT(#9,#8);\n#12='), 'IFC4');
    expect(line(step, 30)).toBe("#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,$);");
  });
});

// #9668: IFC2X3 has no IfcStructuralLoadCase and no SelfWeightCoefficients slot.
describe('IfcStructuralLoadCase IFC4 -> IFC2X3 -> IFC4 #9668', () => {
  const IFC4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));
#21=IFCSTRUCTURALLOADCASE('2gUSy$VNbHyPCNtxi3Mz27',$,'No weight',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$,$);
#22=IFCSTRUCTURALLOADGROUP('0lsMD6XezVsvu_9b4o9$Mn',#5,'Group',$,$,.LOAD_CASE.,.PERMANENT_G.,.DEAD_LOAD_G.,$,$);`);

  it('carries the class and SelfWeightCoefficients in a property set', async () => {
    const down = await convert(IFC4, 'IFC2X3');
    expect(line(down.step, 20)).toBe("#20=IFCSTRUCTURALLOADGROUP('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S');");
    expect(records(down.step, 'IFCPROPERTYSET')).toHaveLength(2);
    expect(records(down.step, 'IFCPROPERTYSET').every((l) => l.includes(`'${LOAD_CASE_PSET}'`))).toBe(true);
    expect(records(down.step, 'IFCPROPERTYLISTVALUE')).toEqual([
      expect.stringMatching(/=IFCPROPERTYLISTVALUE\('SelfWeightCoefficients',\$,\(IFCRATIOMEASURE\(0\.\),IFCRATIOMEASURE\(0\.\),IFCRATIOMEASURE\(-1\.\)\),\$\);$/),
    ]);
    // IFC2X3 requires OwnerHistory on the added rooted records.
    for (const l of [...records(down.step, 'IFCPROPERTYSET'), ...records(down.step, 'IFCRELDEFINESBYPROPERTIES')]) expect(l).toMatch(/^#\d+=\w+\('[^']{22}',#5,/);
    expect(down.warnings).not.toContain('SelfWeightCoefficients has no slot');

    const up = await convert(down.step, 'IFC4');
    expect(line(up.step, 20)).toBe("#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));");
    expect(line(up.step, 21)).toBe("#21=IFCSTRUCTURALLOADCASE('2gUSy$VNbHyPCNtxi3Mz27',#5,'No weight',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$,$);");
    expect(line(up.step, 22)).toMatch(/^#22=IFCSTRUCTURALLOADGROUP\(/);
    expect([...records(up.step, 'IFCPROPERTYSET'), ...records(up.step, 'IFCPROPERTYLISTVALUE'), ...records(up.step, 'IFCPROPERTYSINGLEVALUE'), ...records(up.step, 'IFCRELDEFINESBYPROPERTIES')]).toEqual([]);
  });

  it('keeps a carrier property set that a type object also names', async () => {
    const down = (await convert(IFC4, 'IFC2X3')).step;
    const pset = /^#(\d+)=IFCPROPERTYSET\('[^']+',#5,'IFC4 IfcStructuralLoadCase'/m.exec(down)![1];
    const shared = down.replace('ENDSEC;\nEND-ISO', `#900=IFCBEAMTYPE('3hUSy$VNbHyPCNtxi3Mz27',#5,'T',$,$,(#${pset}),$,$,$,.BEAM.);\nENDSEC;\nEND-ISO`);
    const { step } = await convert(shared, 'IFC4');
    expect(line(step, Number(pset))).toBeDefined();
    expect(records(step, 'IFCBEAMTYPE')[0]).toContain(`(#${pset})`);
  });

  it('leaves a load group with two carrier property sets as a load group', async () => {
    const twice = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALLOADGROUP('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$);
#30=IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.)),$);
#31=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'${LOAD_CASE_PSET}',$,(#30));
#32=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#31);
#33=IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-2.)),$);
#34=IFCPROPERTYSET('4gUSy$VNbHyPCNtxi3Mz27',#5,'${LOAD_CASE_PSET}',$,(#33));
#35=IFCRELDEFINESBYPROPERTIES('1hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#34);`);
    const { step } = await convert(twice, 'IFC4');
    expect(line(step, 20)).toMatch(/^#20=IFCSTRUCTURALLOADGROUP\(/);
    expect(records(step, 'IFCPROPERTYSET')).toHaveLength(2);
  });

  it('keeps a carrier property set that something else also names', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALLOADGROUP('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$);
#21=IFCSTRUCTURALLOADGROUP('2gUSy$VNbHyPCNtxi3Mz27',#5,'Other',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$);
#30=IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.)),$);
#31=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'${LOAD_CASE_PSET}',$,(#30));
#32=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#31);
#33=IFCRELDEFINESBYPROPERTIES('1hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#21),#31);`);
    const { step } = await convert(ifc2x3, 'IFC4');
    expect(line(step, 20)).toMatch(/^#20=IFCSTRUCTURALLOADGROUP\(/);
    expect(line(step, 31)).toBeDefined();
  });
});

// #9668: IFC4 gives varying thicknesses by Pset_StructuralSurfaceMemberVaryingThickness.
describe('varying surface member thickness IFC2X3 <-> IFC4 #9668', () => {
  const geometry = `#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),'Thickness locations',$,.T.,#15);`;
  const IFC2X3 = model('IFC2X3', `${OWNER}
${geometry}
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);`);

  it('writes three thicknesses as the property set and reads them back', async () => {
    const up = await convert(IFC2X3, 'IFC4');
    expect(line(up.step, 20)).toBe("#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2);");
    expect(records(up.step, 'IFCPROPERTYSINGLEVALUE').map((l) => l.replace(/^#\d+=/, ''))).toEqual([
      "IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.2),$);",
      "IFCPROPERTYSINGLEVALUE('Thickness2',$,IFCPOSITIVELENGTHMEASURE(0.25),$);",
      "IFCPROPERTYSINGLEVALUE('Thickness3',$,IFCPOSITIVELENGTHMEASURE(0.3),$);",
    ]);
    expect(records(up.step, 'IFCPROPERTYSET')).toEqual([expect.stringContaining("'Pset_StructuralSurfaceMemberVaryingThickness'")]);
    expect(up.warnings).not.toContain('SubsequentThickness has no slot');

    const down = await convert(up.step, 'IFC2X3');
    expect(line(down.step, 20)).toMatch(/^#20=IFCSTRUCTURALSURFACEMEMBERVARYING\('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',\$,\$,#\d+,#15,\.SHELL\.,0\.2,\(0\.25,0\.3\),#17\);$/);
    // The property set is valid IFC2X3 and stays; a second upgrade does not add another.
    expect(records((await convert(down.step, 'IFC4')).step, 'IFCPROPERTYSET')).toHaveLength(1);
  });

  it('reports the thicknesses lost when an existing property set holds other values', async () => {
    const other = IFC2X3.replace('#20=', `#40=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.9),$);
#41=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'Pset_StructuralSurfaceMemberVaryingThickness',$,(#40));
#42=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#41);
#20=`);
    const up = await convert(other, 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toHaveLength(1);
    expect(up.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
  });

  it('writes no property set for an unset location, even where the representation has no single aspect', async () => {
    const up = await convert(IFC2X3.replace(',#15,.SHELL.', ',$,.SHELL.').replace('(0.25,0.3),#17)', '(0.25,0.3),$)'), 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toEqual([]);
  });

  it('writes no property set when the location is not the one aspect of the representation', async () => {
    const { step } = await convert(IFC2X3.replace('#17=', "#18=IFCSHAPEASPECT((#14),$,$,.T.,#15);\n#17="), 'IFC4');
    expect(records(step, 'IFCPROPERTYSET')).toEqual([]);
  });

  it('leaves an IFC4 member whose Thickness differs from Thickness1 to the previous handling', async () => {
    const up = (await convert(IFC2X3, 'IFC4')).step.replace(',.SHELL.,0.2);', ',.SHELL.,0.5);');
    const { step } = await convert(up, 'IFC2X3');
    expect(line(step, 20)).toContain(',.SHELL.,0.5,$,$);');
  });
});
