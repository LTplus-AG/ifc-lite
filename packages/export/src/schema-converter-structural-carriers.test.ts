/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { LOAD_CASE_PSET } from './schema-converter-structural-carriers.js';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const model = (schema: string, data: string): string =>
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [StructuralAnalysisView]'),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
const parse = (text: string): Promise<IfcDataStore> => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);
const line = (step: string, id: number): string | undefined => step.split('\n').find((l) => l.startsWith(`#${id}=`));
const records = (step: string, type: string): string[] => step.split('\n').filter((l) => new RegExp(`^#\\d+=${type}\\(`).test(l));
const convert = async (text: string, schema: 'IFC2X3' | 'IFC4') => {
  const result = new StepExporter(await parse(text)).export({ schema });
  return { step: new TextDecoder().decode(result.content), warnings: result.stats.warnings.join('\n') };
};

/** `Type.Attribute` -> the ids `analyzeConversionLoss` names as dropping it. */
const lossIds = async (text: string, from: 'IFC2X3' | 'IFC4', to: 'IFC2X3' | 'IFC4') =>
  Object.fromEntries(analyzeConversionLoss(await parse(text), from, to).entries
    .flatMap((e) => e.droppedAttributes.map((a) => [`${e.sourceType}.${a}`, e.expressIds])));

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

  it('reads two Causes relationships naming the same reaction as one cause', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#20),$,#21);
#31=IFCRELASSIGNSTOPRODUCT('1bbbbbbbbbbbbbbbbbbbbb',#5,'Causes',$,(#20),$,#21);`);
    expect(line((await convert(ifc4, 'IFC2X3')).step, 21)).toContain(',.F.,#20,.TRUE_LENGTH.);');
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
    // The item on the higher-id copy is listed first, so the lowest id, not the first item, is chosen.
    const { step } = await convert(ifc2x3('#10').replace('(#20,#21,#22)', '(#21,#20,#22)'), 'IFC4');
    expect(line(step, 30)).toBe("#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#9);");
    expect(line(step, 21)).toBe("#21=IFCSTRUCTURALPOINTCONNECTION('1IIB7Cy$HI3REa9CT8boqX',#5,'N',$,$,#9,$,$,$);");
    // The beam is not a structural item, so it keeps its own placement.
    expect(line(step, 22)).toContain(",'Beam',$,$,#10,");
  });

  it('places by neither model an item two models would place differently', async () => {
    // Model 1 shares #9 (its items on #9 and #10); model 2 shares #10 (its items on #10 and #14), all equal copies.
    const twoModels = ifc2x3('#10').replace('#31=', `#14=IFCLOCALPLACEMENT($,#8);
#23=IFCSTRUCTURALCURVEMEMBER('1XciGbSFPUkgAKmWK4M6tc',#5,'M2',$,$,#14,$,.RIGID_JOINED_MEMBER.);
#32=IFCSTRUCTURALANALYSISMODEL('4rBQGmCZHSd9Yn0gS5NyiS',#5,'Model 2',$,$,.LOADING_3D.,$,$,$);
#33=IFCRELASSIGNSTOGROUP('2rjQw6HYfMHPFWRTOSlRaA',#5,$,$,(#21,#23),$,#32);
#31=`);
    const { step } = await convert(twoModels, 'IFC4');
    expect(line(step, 21)).toContain(",'N',$,$,#10,");
    expect(line(step, 30)).toMatch(/,\$\);$/);
    expect(line(step, 32)).toMatch(/,\$\);$/);
  });

  it('reports a SharedPlacement the upgrade cannot restore as lost', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#13=IFCGRIDPLACEMENT($,$,$);
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#13,$,.RIGID_JOINED_MEMBER.,$);
#30=IFCSTRUCTURALANALYSISMODEL('3rBQGmCZHSd9Yn0gS5NyiS',#5,'Model',$,$,.LOADING_3D.,$,$,$,#13);
#31=IFCRELASSIGNSTOGROUP('1rjQw6HYfMHPFWRTOSlRaA',#5,$,$,(#20),$,#30);`);
    const { warnings } = await convert(ifc4, 'IFC2X3');
    expect(warnings).toContain('IFCSTRUCTURALANALYSISMODEL.SharedPlacement has no slot in IFC2X3; its value is omitted');
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

  it('reads typed coefficients, and leaves a malformed list to the loss report', async () => {
    const typed = IFC4.replace('(0.,0.,-1.));', '(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.)));');
    const down = await convert(typed, 'IFC2X3');
    expect(records(down.step, 'IFCPROPERTYLISTVALUE')[0]).toContain('(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.))');
    const malformed = await convert(IFC4.replace('(0.,0.,-1.));', '(0.,-1.));'), 'IFC2X3');
    expect(records(malformed.step, 'IFCPROPERTYLISTVALUE')).toEqual([]);
    expect(malformed.warnings).toContain('IFCSTRUCTURALLOADCASE.SelfWeightCoefficients has no slot in IFC2X3');
  });

  it('does not count an id inside a string as naming a carrier', async () => {
    const down = (await convert(IFC4, 'IFC2X3')).step;
    // The carrier set #20 itself has, found through its relationship.
    const pset = /^#\d+=IFCRELDEFINESBYPROPERTIES\('[^']+',#5,\$,\$,\(#20\),#(\d+)\);$/m.exec(down)![1];
    const noted = down.replace("'No weight',$,", `'No weight','see #${pset}',`);
    expect(line((await convert(noted, 'IFC4')).step, 20)).toMatch(/^#20=IFCSTRUCTURALLOADCASE\(/);
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

  it('applies the location rule even when an existing property set matches', async () => {
    const matching = IFC2X3.replace('#20=', `#40=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.2),$);
#43=IFCPROPERTYSINGLEVALUE('Thickness2',$,IFCPOSITIVELENGTHMEASURE(0.25),$);
#44=IFCPROPERTYSINGLEVALUE('Thickness3',$,IFCPOSITIVELENGTHMEASURE(0.3),$);
#41=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'Pset_StructuralSurfaceMemberVaryingThickness',$,(#40,#43,#44));
#42=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#41);
#20=`);
    const kept = await convert(matching, 'IFC4');
    expect(kept.warnings).toContain('IFC2X3 SubsequentThickness is held in IFC4');
    expect(kept.warnings).not.toContain('has no slot in IFC4');
    expect(records(kept.step, 'IFCPROPERTYSET')).toHaveLength(1);
    // A second aspect on the representation: the location would not come back, so both are reported lost.
    const elsewhere = await convert(matching.replace('#17=', "#18=IFCSHAPEASPECT((#14),$,$,.T.,#15);\n#17="), 'IFC4');
    expect(elsewhere.warnings).not.toContain('SubsequentThickness is held');
    expect(elsewhere.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
    expect(elsewhere.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.VaryingThicknessLocation has no slot in IFC4');
    expect(records(elsewhere.step, 'IFCPROPERTYSET')).toHaveLength(1);
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

  it('writes no property set for an unset location on a member without representation', async () => {
    const up = await convert(IFC2X3.replace(',#15,.SHELL.', ',$,.SHELL.').replace('(0.25,0.3),#17)', '(0.25,0.3),$)'), 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toEqual([]);
    expect(up.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
  });

  it('leaves an IFC4 member whose location aspect is not points, or whose thickness has its own unit, to the previous handling', async () => {
    const up = (await convert(IFC2X3, 'IFC4')).step;
    const polyline = up.replace("#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));", "#18=IFCPOLYLINE((#7,#7));\n#16=IFCSHAPEREPRESENTATION(#13,'Reference','Curve',(#18));");
    expect(line((await convert(polyline, 'IFC2X3')).step, 20)).toContain(',.SHELL.,0.2,$,$);');
    const unit = up.replace(/IFCPOSITIVELENGTHMEASURE\(0\.25\),\$\)/, 'IFCPOSITIVELENGTHMEASURE(250.),#7)');
    expect(line((await convert(unit, 'IFC2X3')).step, 20)).toContain(',.SHELL.,0.2,$,$);');
  });

  it('requires each location representation to hold exactly one point, on the way up and down', async () => {
    const twoPoints = IFC2X3.replace("#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));", "#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7,#7));");
    const twoUp = await convert(twoPoints, 'IFC4');
    // No property set the downgrade could pair with another aspect: both are reported lost.
    expect(records(twoUp.step, 'IFCPROPERTYSET')).toEqual([]);
    expect(twoUp.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
    expect(twoUp.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.VaryingThicknessLocation has no slot in IFC4');
    // Down: a valid IFC4 file whose aspect representation then gets a second point.
    const valid = (await convert(IFC2X3, 'IFC4')).step;
    const twoDown = valid.replace("#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));", "#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7,#7));");
    expect(twoDown).not.toBe(valid);
    expect(line((await convert(twoDown, 'IFC2X3')).step, 20)).toContain(',.SHELL.,0.2,$,$);');
    const onSurface = IFC2X3.replace("#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));", "#18=IFCPLANE(#8);\n#19=IFCPOINTONSURFACE(#18,0.,0.);\n#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#19));");
    const up = await convert(onSurface, 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toHaveLength(1);
    expect(line((await convert(up.step, 'IFC2X3')).step, 20)).toMatch(/,0\.2,\(0\.25,0\.3\),#17\);$/);
  });

  it('writes no property set when the location is not the one aspect of the representation', async () => {
    const { step, warnings } = await convert(IFC2X3.replace('#17=', "#18=IFCSHAPEASPECT((#14),$,$,.T.,#15);\n#17="), 'IFC4');
    expect(records(step, 'IFCPROPERTYSET')).toEqual([]);
    expect(warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
  });

  it('writes no property set for an unset location, so the downgrade adopts no aspect', async () => {
    const up = await convert(IFC2X3.replace('(0.25,0.3),#17)', '(0.25,0.3),$)'), 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toEqual([]);
    expect(up.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
    expect(line((await convert(up.step, 'IFC2X3')).step, 20)).toContain(',.SHELL.,0.2,$,$);');
  });

  it('leaves an IFC4 member whose Thickness differs from Thickness1 to the previous handling', async () => {
    const up = (await convert(IFC2X3, 'IFC4')).step.replace(',.SHELL.,0.2);', ',.SHELL.,0.5);');
    const { step } = await convert(up, 'IFC2X3');
    expect(line(step, 20)).toContain(',.SHELL.,0.5,$,$);');
  });
});

// #9668 final review: a source 'Causes' relationship naming another reaction.
describe('CausedBy beside a source Causes relationship #9668', () => {
  const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#23=IFCSTRUCTURALPOINTREACTION('1KQ0efL39PrP5DeqBwaUNp',#5,'R2',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.);
#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#23),$,#21);`);

  it('keeps CausedBy beside a source Causes naming another reaction, and reports it not restorable', async () => {
    const up = await convert(ifc2x3, 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([
      expect.stringMatching(/^#30=.*'Causes',\$,\(#23\),\$,#21\);$/),
      expect.stringMatching(/'Causes',\$,\(#20\),\$,#21\);$/),
    ]);
    expect(up.warnings).toContain('IFC2X3 CausedBy is one of several reactions');
    expect(up.warnings).not.toContain('CausedBy has no slot in IFC4');
    expect(up.warnings).not.toContain('CausedBy is written as');
    // Back in IFC2X3 the action has two causes, so CausedBy stays unset and both relationships stay.
    const down = await convert(up.step, 'IFC2X3');
    expect(line(down.step, 21)).toContain(',.F.,$,.TRUE_LENGTH.);');
    expect(records(down.step, 'IFCRELASSIGNSTOPRODUCT')).toHaveLength(2);
  });

  it("writes a Causes relationship for an action even when another action's names the same reaction", async () => {
    const other = ifc2x3.replace("(#23),$,#21);", "(#20),$,#22);").replace('#30=', "#22=IFCSTRUCTURALLINEARACTION('0CpCw3$DzVlut_KQsd7u6Y',#5,'B',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);\n#30=");
    const up = await convert(other, 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([
      expect.stringMatching(/^#30=.*'Causes',\$,\(#20\),\$,#22\);$/),
      expect.stringMatching(/'Causes',\$,\(#20\),\$,#21\);$/),
    ]);
    expect(up.warnings).toContain("IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes'");
  });

  it('keeps a source Causes naming the reaction among others, and reports it not restorable', async () => {
    const both = ifc2x3.replace("(#23),$,#21);", "(#20,#23),$,#21);");
    const up = await convert(both, 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([expect.stringMatching(/^#30=.*'Causes',\$,\(#20,#23\),\$,#21\);$/)]);
    expect(up.warnings).toContain('IFC2X3 CausedBy is one of several reactions');
    expect(up.warnings).not.toContain('CausedBy is written as');
    expect(up.warnings).not.toContain('CausedBy has no slot in IFC4');
  });

  it('writes no Causes relationship for a CausedBy that names no reaction', async () => {
    const odd = ifc2x3.replace(',.F.,#20,.TRUE_LENGTH.', ',.F.,#9,.TRUE_LENGTH.').replace(/^#30=.*$/m, '');
    const up = await convert(odd, 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([]);
    expect(up.warnings).toContain('IFCSTRUCTURALLINEARACTION.CausedBy has no slot in IFC4; its value is omitted');
  });
});

// #9668 review (PR #10551): a varying action StructuralVarying leaves unconverted
// (one aspect representation for three loads, as generated_structural_coverage_ifc2x3.ifc #58 held before R12)
// is no IFC4 product, so no 'Causes' relationship may name it.
describe('CausedBy of an unconverted varying action #9668', () => {
  const geometry = `#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),'Coverage aspect',$,.T.,#15);
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);`;
  const varying = (aspect: string) => model('IFC2X3', `${OWNER}
${geometry.replace('(#16),', aspect)}
#30=IFCSTRUCTURALLINEARACTIONVARYING('3sXjCM_kPHN8ZCpuBhV_98',#5,'V',$,$,#9,#15,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.,#17,(#11,#11));`);

  it('writes no Causes relationship and reports CausedBy omitted', async () => {
    const up = await convert(varying('(#16),'), 'IFC4');
    expect(line(up.step, 30)).toMatch(/^#30=IFCSTRUCTURALLINEARACTIONVARYING\(/);
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([]);
    expect(up.warnings).toContain("CausedBy of a varying action that stays unconverted is kept only in that IFC2X3 record");
    expect(up.warnings).not.toContain('CausedBy is written as');
  });

  it('still writes it for a varying action that converts', async () => {
    const up = await convert(varying('(#14,#16,#16),'), 'IFC4');
    expect(line(up.step, 30)).toMatch(/^#30=IFCSTRUCTURALCURVEACTION\(/);
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([expect.stringMatching(/'Causes',\$,\(#20\),\$,#30\);$/)]);
    expect(up.warnings).toContain('CausedBy is written as');
    expect(up.warnings).not.toContain('stays unconverted');
  });

  // #10597: the type classifier calls an IFC2X3 varying action identity, so the preview asks the carriers per record.
  it('names CausedBy lost in the loss preview exactly when the export reports it', async () => {
    const cases = [
      { text: varying('(#16),'), why: 'unconverted, naming a reaction', target: 'IFCSTRUCTURALLINEARACTIONVARYING' },
      { text: varying('(#14,#16,#16),'), why: 'converted, held by Causes', target: null },
      { text: varying('(#14,#16,#16),').replace(',.F.,#20,', ',.F.,#12,'), why: 'converted, naming no reaction', target: 'IFCSTRUCTURALCURVEACTION' },
      { text: varying('(#16),').replace(',.F.,#20,', ',.F.,#12,'), why: 'unconverted, kept in its own record', target: null },
      // A source 'Causes' naming another reaction: IFC4 holds both, so the downgrade cannot restore CausedBy.
      { text: varying('(#14,#16,#16),').replace('ENDSEC;\nEND', `#23=IFCSTRUCTURALPOINTREACTION('1KQ0efL39PrP5DeqBwaUNp',#5,'R2',$,$,#9,$,#12,.GLOBAL_COORDS.);
#31=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes',$,(#23),$,#30);
ENDSEC;\nEND`), why: 'converted, among several causes', target: 'IFCSTRUCTURALCURVEACTION' },
    ];
    for (const { text, why, target } of cases) {
      const { step, warnings } = await convert(text, 'IFC4');
      expect(/CausedBy (has no slot|of a varying action|is one of several)/.test(warnings), why).toBe(target !== null);
      const entry = analyzeConversionLoss(await parse(text), 'IFC2X3', 'IFC4').entries
        .find((e) => e.sourceType === 'IFCSTRUCTURALLINEARACTIONVARYING' && e.droppedAttributes.includes('CausedBy'));
      // The entry names the type the export writes #30 as.
      expect(entry ? { target: entry.targetType, ids: entry.expressIds } : null, why).toEqual(target && { target, ids: [30] });
      if (target) expect(line(step, 30), why).toMatch(new RegExp(`^#30=${target}\\(`));
    }
  });

  it('keeps one entry for the type, naming each record group under the type the export writes it as', async () => {
    // #30 converts and names no reaction; #31 stays unconverted (one aspect representation for two loads) and names one.
    const text = varying('(#14,#16,#16),').replace(',.F.,#20,', ',.F.,#12,') .replace('ENDSEC;\nEND', `#18=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#19=IFCSHAPEASPECT((#16),'Coverage aspect',$,.T.,#18);
#31=IFCSTRUCTURALLINEARACTIONVARYING('4sXjCM_kPHN8ZCpuBhV_98',#5,'W',$,$,#9,#18,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.,#19,(#11,#11));
ENDSEC;\nEND`);
    const step = (await convert(text, 'IFC4')).step;
    expect(line(step, 30)).toMatch(/^#30=IFCSTRUCTURALCURVEACTION\(/);
    expect(line(step, 31)).toMatch(/^#31=IFCSTRUCTURALLINEARACTIONVARYING\(/);
    const report = analyzeConversionLoss(await parse(text), 'IFC2X3', 'IFC4');
    const entries = report.entries.filter((e) => e.sourceType === 'IFCSTRUCTURALLINEARACTIONVARYING');
    expect(entries).toHaveLength(1);
    expect(entries[0].recordGroups?.map((g) => [g.targetType, g.expressIds, g.droppedAttributes])).toEqual([
      ['IFCSTRUCTURALCURVEACTION', [30], ['CausedBy']], ['IFCSTRUCTURALLINEARACTIONVARYING', [31], ['CausedBy']],
    ]);
    expect(report.describe().filter((d) => d.includes('CausedBy'))).toEqual([
      expect.stringContaining('IFCSTRUCTURALLINEARACTIONVARYING → IFCSTRUCTURALCURVEACTION (#30)'),
      expect.stringContaining('IFCSTRUCTURALLINEARACTIONVARYING → IFCSTRUCTURALLINEARACTIONVARYING (#31)'),
    ]);
  });

  it('reports no CausedBy message for a CausedBy that names no point reaction', async () => {
    const up = await convert(varying('(#16),').replace(',.F.,#20,.TRUE_LENGTH.', ',.F.,#9,.TRUE_LENGTH.'), 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([]);
    // No CausedBy message of any kind (every Causes message names CausedBy too).
    expect(up.warnings).not.toContain('CausedBy');
    expect(up.warnings).toContain('IFCSTRUCTURALLINEARACTIONVARYING has no representation in IFC4; record remains unconverted');
  });

  it('carries the selected reaction when a subset falls back to the primary load (#11037)', async () => {
    const result = new StepExporter(await parse(varying('(#16),'))).export({ schema: 'IFC4', subsetEntityIds: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 20, 30]) });
    const step = new TextDecoder().decode(result.content);
    expect(line(step, 30)).toMatch(/^#30=IFCSTRUCTURALCURVEACTION\(.*\.CONST\.\);$/);
    expect(records(step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([expect.stringContaining("'Causes',$,(#20),$,#30);")]);
    const warnings = result.stats.warnings.join('\n');
    expect(warnings).toContain('no complete load configuration');
    expect(warnings).toContain('CausedBy is written as');
  });
});

// #9668 review (PR #10551): STEP comments stay in a slot's text (#10248).
describe('carrier references beside STEP comments #9668', () => {
  it('reads a CausedBy and a Causes relationship that carry comments', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20 /* cause */,.TRUE_LENGTH.);`);
    const up = await convert(ifc2x3, 'IFC4');
    expect(records(up.step, 'IFCRELASSIGNSTOPRODUCT')).toEqual([expect.stringMatching(/'Causes',\$,\(#20\),\$,#21\);$/)]);
    const commented = up.step.replace(/'Causes',\$,\(#20\),\$,#21\);/, "'Causes',$,(/* r */ #20),$,#21 /* action */);");
    expect(line((await convert(commented, 'IFC2X3')).step, 21)).toContain(',.F.,#20,.TRUE_LENGTH.);');
  });
});

// #9668 review (PR #10551): a native IFC4 thickness set that gives locations.
describe('varying thickness with property-set locations #9668', () => {
  it('refuses to pair thicknesses with the aspect when the set gives locations, and warns', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),$,$,.T.,#15);
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2);
#40=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.2),$);
#41=IFCPROPERTYSINGLEVALUE('Thickness2',$,IFCPOSITIVELENGTHMEASURE(0.25),$);
#42=IFCPROPERTYSINGLEVALUE('Thickness3',$,IFCPOSITIVELENGTHMEASURE(0.3),$);
#43=IFCPROPERTYLISTVALUE('Location1Local',$,(IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.)),$);
#44=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'Pset_StructuralSurfaceMemberVaryingThickness',$,(#40,#41,#42,#43));
#45=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#44);`);
    const down = await convert(ifc4, 'IFC2X3');
    expect(line(down.step, 20)).toContain(',.SHELL.,0.2,$,$);');
    expect(down.warnings).toContain('1 structural conversion record(s): Pset_StructuralSurfaceMemberVaryingThickness gives Location properties, which cannot be checked against the IfcShapeAspect order');
    const plain = await convert(ifc4.replace(',(#40,#41,#42,#43));', ',(#40,#41,#42));'), 'IFC2X3');
    expect(line(plain.step, 20)).toMatch(/,0\.2,\(0\.25,0\.3\),#17\);$/);
    // An empty location property gives no location.
    for (const blank of ["'Location1Local',$,$,$)", "'Location1Local',$,(),$)", "'Location1Local',$,/* none */(),$)"]) {
      const empty = await convert(ifc4.replace("'Location1Local',$,(IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.)),$)", blank), 'IFC2X3');
      expect(line(empty.step, 20)).toMatch(/,0\.2,\(0\.25,0\.3\),#17\);$/);
      expect(empty.warnings).not.toContain('gives Location properties');
    }
    // A location given another way (a bounded value) still counts.
    const bounded = await convert(ifc4.replace("IFCPROPERTYLISTVALUE('Location1Local',$,(IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.)),$)", "IFCPROPERTYBOUNDEDVALUE('Location1Local',$,$,IFCLENGTHMEASURE(1.),$,$)"), 'IFC2X3');
    expect(line(bounded.step, 20)).toContain(',.SHELL.,0.2,$,$);');
    expect(bounded.warnings).toContain('gives Location properties');
    // The reason is given whatever else would have stopped the thicknesses (here a second aspect).
    const twoAspects = await convert(ifc4.replace('#20=', "#18=IFCSHAPEASPECT((#14),$,$,.T.,#15);\n#20="), 'IFC2X3');
    expect(line(twoAspects.step, 20)).toContain(',.SHELL.,0.2,$,$);');
    expect(twoAspects.warnings).toContain('gives Location properties');
    // The member's own Thickness unset: written as without a set, so it stays unset and IFC2X3's required slots are reported.
    const ownUnset = await convert(ifc4.replace(',.SHELL.,0.2);', ',.SHELL.,$);'), 'IFC2X3');
    expect(line(ownUnset.step, 20)).toContain(',.SHELL.,$,$,$);');
    expect(ownUnset.warnings).toContain('gives Location properties');
    expect(ownUnset.warnings).toContain('where IFC2X3 requires a value');
  });

  it('does not count a located set as holding the thicknesses on the upgrade', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),$,$,.T.,#15);
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);
#40=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.2),$);
#41=IFCPROPERTYSINGLEVALUE('Thickness2',$,IFCPOSITIVELENGTHMEASURE(0.25),$);
#42=IFCPROPERTYSINGLEVALUE('Thickness3',$,IFCPOSITIVELENGTHMEASURE(0.3),$);
#43=IFCPROPERTYLISTVALUE('Location1Local',$,(IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.)),$);
#44=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'Pset_StructuralSurfaceMemberVaryingThickness',$,(#40,#41,#42,#43));
#45=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#44);`);
    const up = await convert(ifc2x3, 'IFC4');
    expect(up.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
    expect(up.warnings).not.toContain('SubsequentThickness is held');
    expect(records(up.step, 'IFCPROPERTYSET')).toHaveLength(1);
  });

  it('reads a Causes label and a property set name beside STEP comments', async () => {
    const ifc4 = model('IFC4', `${OWNER}
#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);
#30=IFCRELASSIGNSTOPRODUCT('1aaaaaaaaaaaaaaaaaaaaa',#5,'Causes' /* why */,$,(#20),$,#21);`);
    expect(line((await convert(ifc4, 'IFC2X3')).step, 21)).toContain(',.F.,#20,.TRUE_LENGTH.);');
    // A comment inside the quotes is part of the name, which then is not 'Causes'.
    const inside = ifc4.replace("'Causes' /* why */", "'Causes/* old */'");
    expect(line((await convert(inside, 'IFC2X3')).step, 21)).toContain(',.F.,$,.TRUE_LENGTH.);');
  });
});

// #9668 review (PR #10551): IfcPropertySet names its properties uniquely (IFC4
// UniquePropertyNames, IFC2X3 WR32); a carrier set breaking that is not read.
describe('carrier property set with a duplicate property name #9668', () => {
  it('leaves the load group as it is', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALLOADGROUP('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$);
#30=IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-1.)),$);
#31=IFCPROPERTYLISTVALUE('SelfWeightCoefficients',$,(IFCRATIOMEASURE(0.),IFCRATIOMEASURE(0.),IFCRATIOMEASURE(-2.)),$);
#32=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'${LOAD_CASE_PSET}',$,(#30,#31));
#33=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#32);`);
    const { step } = await convert(ifc2x3, 'IFC4');
    expect(line(step, 20)).toMatch(/^#20=IFCSTRUCTURALLOADGROUP\(/);
    for (const id of [30, 31, 32, 33]) expect(line(step, id)).toBeDefined();
  });

  it('gives a varying member no second thickness set', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),$,$,.T.,#15);
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);
#40=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.2),$);
#41=IFCPROPERTYSINGLEVALUE('Thickness1',$,IFCPOSITIVELENGTHMEASURE(0.9),$);
#44=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'Pset_StructuralSurfaceMemberVaryingThickness',$,(#40,#41));
#45=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#44);`);
    const up = await convert(ifc2x3, 'IFC4');
    expect(records(up.step, 'IFCPROPERTYSET')).toEqual([expect.stringMatching(/^#44=/)]);
    expect(up.warnings).toContain('IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness has no slot in IFC4');
  });
});

// #9668 review (PR #10551): a short source record must not abort the prepass.
describe('carrier prepass on a truncated property set #9668', () => {
  it('converts the file, reading no carrier from it', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#20=IFCSTRUCTURALLOADGROUP('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,$,$);
#32=IFCPROPERTYSET('3gUSy$VNbHyPCNtxi3Mz27',#5,'${LOAD_CASE_PSET}');
#33=IFCRELDEFINESBYPROPERTIES('0hUSy$VNbHyPCNtxi3Mz27',#5,$,$,(#20),#32);`);
    const { step } = await convert(ifc2x3, 'IFC4');
    expect(line(step, 20)).toMatch(/^#20=IFCSTRUCTURALLOADGROUP\(/);
    expect(records(step, 'IFCSTRUCTURALLOADCASE')).toEqual([]);
    for (const id of [32, 33]) expect(line(step, id)).toBeDefined();
  });
});

// #10597: the conversion loss preview does not name lost what a carrier keeps, and still names what it declines.
describe('conversion loss report and structural carriers #10597', () => {
  const preview = async (text: string, from: 'IFC2X3' | 'IFC4', to: 'IFC2X3' | 'IFC4') => Object.keys(await lossIds(text, from, to));
  const cases = [
    ['IFCSTRUCTURALLINEARACTION.CausedBy', 'IFC2X3', 'IFC4', `#20=IFCSTRUCTURALPOINTREACTION('0KQ0efL39PrP5DeqBwaUNp',#5,'R',$,$,#9,$,#12,.GLOBAL_COORDS.);
#21=IFCSTRUCTURALLINEARACTION('2CpCw3$DzVlut_KQsd7u6Y',#5,'A',$,$,#9,$,#11,.GLOBAL_COORDS.,.F.,#20,.TRUE_LENGTH.);`],
    ['IFCSTRUCTURALSURFACEMEMBERVARYING.SubsequentThickness', 'IFC2X3', 'IFC4', `#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#16),'Thickness locations',$,.T.,#15);
#20=IFCSTRUCTURALSURFACEMEMBERVARYING('2KZvpy1jjNYvbqlQZoD987',#5,'Slab',$,$,#9,#15,.SHELL.,0.2,(0.25,0.3),#17);`],
    ['IFCSTRUCTURALLOADCASE.SelfWeightCoefficients', 'IFC4', 'IFC2X3', `#20=IFCSTRUCTURALLOADCASE('1gUSy$VNbHyPCNtxi3Mz27',#5,'Case',$,$,.LOAD_CASE.,.VARIABLE_Q.,.LIVE_LOAD_Q.,1.5,'S',(0.,0.,-1.));`],
    ['IFCSTRUCTURALCURVEMEMBER.Axis', 'IFC4', 'IFC2X3', `#35=IFCDIRECTION((0.,0.,1.));
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,$,$,.RIGID_JOINED_MEMBER.,#35);`],
  ] as const;

  it.each(cases)('does not report %s lost, as the export keeps it', async (carried, from, to, data) => {
    const text = model(from, `${OWNER}\n${data}`);
    expect((await convert(text, to)).warnings).not.toContain(`${carried} has no slot`);
    expect(await preview(text, from, to)).not.toContain(carried);
  });

  // The same records, each changed so its carrier declines it.
  const declined = [
    { lost: cases[0][0], from: 'IFC2X3', to: 'IFC4', data: cases[0][3].replace(',.F.,#20,', ',.F.,#9,'), why: 'CausedBy names no point reaction' },
    { lost: cases[1][0], from: 'IFC2X3', to: 'IFC4', data: cases[1][3].replace('(0.25,0.3),#17)', '(0.25,0.3),$)'), why: 'no thickness location' },
    { lost: cases[2][0], from: 'IFC4', to: 'IFC2X3', data: cases[2][3].replace('(0.,0.,-1.)', '(0.,-1.)'), why: 'two coefficients' },
    { lost: cases[3][0], from: 'IFC4', to: 'IFC2X3', data: cases[3][3].replace('#20=', `#42=IFCMATERIAL('Steel',$,$);
#40=IFCMATERIALPROFILE($,$,#42,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,$);
#20=`), why: 'its association is refused' },
  ] as const;

  it.each(declined)('reports $lost lost when the export does ($why)', async ({ lost, from, to, data }) => {
    const text = model(from, `${OWNER}\n${data}`);
    expect((await convert(text, to)).warnings).toContain(`${lost} has no slot`);
    expect(await preview(text, from, to)).toContain(lost);
  });

  it('names only the declined record of a type whose other record the carrier keeps', async () => {
    const text = model('IFC4', `${OWNER}
${cases[2][3]}
${cases[2][3].replace('#20=', '#21=').replace('1gUSy$', '2gUSy$').replace('(0.,0.,-1.)', '(0.,-1.)')}`);
    expect((await lossIds(text, 'IFC4', 'IFC2X3'))['IFCSTRUCTURALLOADCASE.SelfWeightCoefficients']).toEqual([21]);
  });

  it('carries SelfWeightCoefficients from a split-line load case', async () => {
    const split = cases[2][3].replace(',.LOAD_CASE.,', ',.LOAD_CASE.,\n  ');
    const text = model('IFC4', `${OWNER}\n${split}`);
    const { step } = await convert(text, 'IFC2X3');
    expect(line(step, 20)).toContain('=IFCSTRUCTURALLOADGROUP(');
    expect(step).toContain("'IFC4 IfcStructuralLoadCase'");
    expect((await lossIds(text, 'IFC4', 'IFC2X3'))['IFCSTRUCTURALLOADCASE.SelfWeightCoefficients']).toBeUndefined();
  });

  // The export refuses this file (StructuralVarying.checkSharedConfigurations); the preview reports it without the carriers.
  it('does not throw, and keeps the carriers out, when the export refuses a shared load configuration', async () => {
    const text = model('IFC4', `${OWNER}
#13=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#14=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSHAPEREPRESENTATION(#13,'Reference','Point',(#7));
#17=IFCSHAPEASPECT((#14,#16),'Locations',$,.T.,#15);
#18=IFCSTRUCTURALLOADLINEARFORCE('end',0.,0.,-9.,0.,0.,0.);
#25=IFCSTRUCTURALLOADCONFIGURATION($,(#11,#18),$);
#30=IFCSTRUCTURALCURVEACTION('0d2HL$ILbNDhwyUI0qw12$',#5,'Line',$,$,$,#15,#25,.GLOBAL_COORDS.,.F.,$,.LINEAR.);
#31=IFCSTRUCTURALCURVEACTION('1d2HL$ILbNDhwyUI0qw12$',#5,'Sinus',$,$,$,#15,#25,.GLOBAL_COORDS.,.F.,$,.SINUS.);
${cases[2][3]}`);
    await expect(convert(text, 'IFC2X3')).rejects.toThrow(/IFCSTRUCTURALLOADCONFIGURATION shared/);
    expect((await lossIds(text, 'IFC4', 'IFC2X3'))['IFCSTRUCTURALLOADCASE.SelfWeightCoefficients']).toEqual([20]);
  });
});

// #9668: IFC4 IfcStructuralCurveMember.Axis (IFC4_ADD2_TC1.exp:9423) has no
// IFC2X3 slot (IFC2X3_TC1.exp:7281). IFC2X3 holds it as
// IfcRelAssociatesProfileProperties.ProfileOrientation (IFC2X3_TC1.exp:6548),
// in the analysis model's frame; IFC4 gives Axis in the ObjectPlacement frame.
describe('curve member Axis IFC4 -> IFC2X3 -> IFC4 #9668', () => {
  const data = (step: string): string[] => step.split('\n').filter((l) => /^#\d+=/.test(l)).sort();
  // #9 is unrotated; #31 turns +X to +Y; #33, relative to #31, turns +Z to +Y.
  const FRAMES = `#30=IFCDIRECTION((0.,1.,0.));
#31=IFCLOCALPLACEMENT($,#32);
#32=IFCAXIS2PLACEMENT3D(#7,$,#30);
#33=IFCLOCALPLACEMENT(#31,#34);
#34=IFCAXIS2PLACEMENT3D(#7,#30,$);
#35=IFCDIRECTION((0.,0.,1.));
#36=IFCDIRECTION((1.,0.,0.));`;
  const ifc4 = (members: string) => model('IFC4', `${OWNER}\n${FRAMES}\n${members}`);
  const UNPLACED = ifc4(`#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,$,$,.RIGID_JOINED_MEMBER.,#35);
#21=IFCSTRUCTURALCURVEMEMBERVARYING('1XciGbSFPUkgAKmWK4M6tc',#5,'V',$,$,#9,$,.RIGID_JOINED_MEMBER.,#35);`);
  const PLACED = ifc4(`#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#31,$,.RIGID_JOINED_MEMBER.,#36);
#21=IFCSTRUCTURALCURVEMEMBER('1XciGbSFPUkgAKmWK4M6tc',#5,'N',$,$,#33,$,.RIGID_JOINED_MEMBER.,#35);`);
  const carrier = (step: string, member: number) => {
    const rel = records(step, 'IFCRELASSOCIATESPROFILEPROPERTIES').find((l) => l.includes(`,(#${member}),`));
    const [, props, orientation] = /,#(\d+),\$,#(\d+)\);$/.exec(rel ?? '') ?? [];
    return { rel, props: line(step, Number(props)), orientation: line(step, Number(orientation)) };
  };

  it('writes the Axis of an unplaced or unrotated member as ProfileOrientation naming the same direction', async () => {
    const down = await convert(UNPLACED, 'IFC2X3');
    for (const member of [20, 21]) {
      const { rel, props, orientation } = carrier(down.step, member);
      expect(rel).toMatch(new RegExp(`^#\\d+=IFCRELASSOCIATESPROFILEPROPERTIES\\('[^']{22}',#5,'IFC4 Axis',\\$,\\(#${member}\\),#\\d+,\\$,#35\\);$`));
      expect(props).toMatch(/^#\d+=IFCGENERALPROFILEPROPERTIES\(\$,\$,\$,\$,\$,\$,\$\);$/);
      expect(orientation).toBe('#35=IFCDIRECTION((0.,0.,1.));');
    }
    expect(down.warnings).not.toContain('.Axis has no slot in IFC2X3');
    expect(down.warnings).toContain('IFC4 Axis is written as IfcRelAssociatesProfileProperties.ProfileOrientation');
  });

  it('turns the Axis of a placed member into the analysis model frame', async () => {
    const down = await convert(PLACED, 'IFC2X3');
    // #20: local +X under a frame whose +X is world +Y.
    expect(carrier(down.step, 20).orientation).toMatch(/^#\d+=IFCDIRECTION\(\(0\.,1\.,0\.\)\);$/);
    // #21: local +Z is #31's +Y, which is world -X.
    expect(carrier(down.step, 21).orientation).toMatch(/^#\d+=IFCDIRECTION\(\(-1\.,0\.,0\.\)\);$/);
    expect(down.warnings).not.toContain('.Axis has no slot in IFC2X3');
  });

  it('gives back the source records and no others', async () => {
    for (const source of [UNPLACED, PLACED]) {
      const down = await convert(source, 'IFC2X3');
      const up = await convert(down.step, 'IFC4');
      expect(data(up.step)).toEqual(data(source));
      expect(up.warnings).not.toContain('Axis is required by IFC4 but unknown');
    }
  });

  it('gives back the source records through a tilted frame, writing no float noise', async () => {
    const tilted = ifc4(`#37=IFCDIRECTION((0.2,0.3,0.9));
#38=IFCDIRECTION((1.,0.5,0.));
#39=IFCAXIS2PLACEMENT3D(#7,#37,#38);
#40=IFCLOCALPLACEMENT($,#39);
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#40,$,.RIGID_JOINED_MEMBER.,#36);`);
    const down = await convert(tilted, 'IFC2X3');
    expect(carrier(down.step, 20).orientation).not.toMatch(/E-1[0-9]/);
    const up = await convert(down.step, 'IFC4');
    expect(data(up.step)).toEqual(data(tilted));
  });

  it('reads a placement in the plane, whose RefDirection has two ratios', async () => {
    const planar = ifc4(`#37=IFCDIRECTION((0.,1.));
#38=IFCAXIS2PLACEMENT2D($,#37);
#39=IFCLOCALPLACEMENT($,#38);
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,#39,$,.RIGID_JOINED_MEMBER.,#36);`);
    expect(carrier((await convert(planar, 'IFC2X3')).step, 20).orientation).toMatch(/=IFCDIRECTION\(\(0\.,1\.,0\.\)\);$/);
  });

  it('carries an Axis an association holds at another length', async () => {
    const held = UNPLACED.replace('#20=', `#37=IFCDIRECTION((0.,0.,2.));
#40=IFCGENERALPROFILEPROPERTIES('HEA 200',$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,#37);
#20=`);
    const down = await convert(held, 'IFC2X3');
    expect(down.warnings).not.toContain('IFCSTRUCTURALCURVEMEMBER.Axis has no slot in IFC2X3');
    expect(records(down.step, 'IFCRELASSOCIATESPROFILEPROPERTIES').filter((l) => l.includes('(#20)'))).toEqual([line(held, 41)]);
  });

  it('fills the unset orientation of an association the member already has, and adds none', async () => {
    const own = PLACED.replace('#20=', `#40=IFCGENERALPROFILEPROPERTIES('HEA 200',$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,$);
#20=`);
    const down = await convert(own, 'IFC2X3');
    const rels = records(down.step, 'IFCRELASSOCIATESPROFILEPROPERTIES');
    expect(rels).toHaveLength(2);
    const [, orientation] = /^#41=IFCRELASSOCIATESPROFILEPROPERTIES\('2XciGbSFPUkgAKmWK4M6tc',#5,\$,\$,\(#20\),#40,\$,#(\d+)\);$/.exec(line(down.step, 41) ?? '') ?? [];
    expect(line(down.step, Number(orientation))).toMatch(/=IFCDIRECTION\(\(0\.,1\.,0\.\)\);$/);
    // The upgrade reads it back and keeps the association, which is the source's.
    const up = await convert(down.step, 'IFC4');
    expect(line(up.step, 20)).toBe(line(own, 20));
    expect(line(up.step, 40)).toBe(line(own, 40));
  });

  it('fills the Axis orientation in a split-line association and keeps it in the preview', async () => {
    const split = PLACED.replace('#20=', `#40=IFCGENERALPROFILEPROPERTIES('HEA 200',$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,
  (#20),#40,$,$);
#20=`);
    const { step } = await convert(split, 'IFC2X3');
    const [, orientation] = /^#41=IFCRELASSOCIATESPROFILEPROPERTIES\([^;]*\(#20\),#40,\$,#(\d+)\);$/m.exec(step) ?? [];
    expect(line(step, Number(orientation))).toMatch(/=IFCDIRECTION\(\(0\.,1\.,0\.\)\);$/);
    expect((await lossIds(split, 'IFC4', 'IFC2X3'))['IFCSTRUCTURALCURVEMEMBER.Axis']).toBeUndefined();
  });

  it('keeps the Axis in the preview when a split association already holds it', async () => {
    const split = UNPLACED.replace('#20=', `#40=IFCGENERALPROFILEPROPERTIES('HEA 200',$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,
  (#20),#40,$,#30);
#20=`).replace('#35);', '#30);');
    expect((await convert(split, 'IFC2X3')).step).toContain('(#20),#40,$,#30);');
    expect((await lossIds(split, 'IFC4', 'IFC2X3'))['IFCSTRUCTURALCURVEMEMBER.Axis']).toBeUndefined();
  });

  it('reports the Axis lost, and writes no direction, when the association it would fill is refused', async () => {
    // The IFC4-only material profile is withheld from IFC2X3, so an association naming it cannot be written as filled.
    const refused = PLACED.replace('#20=', `#42=IFCMATERIAL('Steel',$,$);
#40=IFCMATERIALPROFILE($,$,#42,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,$);
#20=`);
    const down = await convert(refused, 'IFC2X3');
    expect(down.warnings).toContain('IFCSTRUCTURALCURVEMEMBER.Axis has no slot in IFC2X3; its value is omitted');
    expect(records(down.step, 'IFCDIRECTION')).toHaveLength(records(refused, 'IFCDIRECTION').length + 1);
  });

  it('keeps an association whose orientation already holds the Axis, and reports one that holds another as lost', async () => {
    const held = (orientation: string) => UNPLACED.replace('#20=', `#40=IFCGENERALPROFILEPROPERTIES('HEA 200',$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,${orientation});
#20=`);
    const same = await convert(held('#30').replace('#35);', '#30);'), 'IFC2X3');
    expect(records(same.step, 'IFCRELASSOCIATESPROFILEPROPERTIES').filter((l) => l.includes('(#20)'))).toEqual([line(held('#30'), 41)]);
    const other = await convert(held('#36'), 'IFC2X3');
    expect(records(other.step, 'IFCRELASSOCIATESPROFILEPROPERTIES').filter((l) => l.includes('(#20)'))).toEqual([line(held('#36'), 41)]);
    expect(other.warnings).toContain('IFCSTRUCTURALCURVEMEMBER.Axis has no slot in IFC2X3; its value is omitted');
  });

  it('keeps an empty profile-properties association the IFC2X3 source had', async () => {
    const ifc2x3 = model('IFC2X3', `${OWNER}
#35=IFCDIRECTION((0.,0.,1.));
#20=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#5,'M',$,$,$,$,.RIGID_JOINED_MEMBER.);
#40=IFCGENERALPROFILEPROPERTIES($,$,$,$,$,$,$);
#41=IFCRELASSOCIATESPROFILEPROPERTIES('2XciGbSFPUkgAKmWK4M6tc',#5,$,$,(#20),#40,$,#35);`);
    const { step } = await convert(ifc2x3, 'IFC4');
    expect(line(step, 20)).toContain('.RIGID_JOINED_MEMBER.,#35);');
    expect(line(step, 40)).toBeDefined();
    expect(line(step, 41)).toBeDefined();
  });
});
