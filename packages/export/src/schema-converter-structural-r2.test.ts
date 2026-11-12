/* SPDX-License-Identifier: MPL-2.0 */
import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

// #9668: the invariant is semantic stiffness, including IFC2X3's rigid -1
// sentinel, and correct action slots rather than positional enum placement.
describe('structural schema conformance #9668', () => {
  for (const [type, values] of [
    ['IFCBOUNDARYNODECONDITION', '12.,23.,34.,0.,45.,56.'],
    ['IFCBOUNDARYNODECONDITIONWARPING', '12.,23.,34.,0.,45.,56.,3.5'],
    ['IFCBOUNDARYEDGECONDITION', '12.,23.,34.,0.,45.,56.'],
    ['IFCBOUNDARYFACECONDITION', '12.,23.,34.'],
  ]) {
    it(`${type} wraps SELECT measures and restores IFC2X3 values`, () => {
      const source = `#23=${type}('Support',${values});`;
      const there = convertStepLine(source, 'IFC2X3', 'IFC4');
      expect(there).toMatch(/IFC\w+MEASURE\(12\.\)/);
      expect(convertStepLine(there!, 'IFC4', 'IFC2X3')).toBe(source);
    });
  }
  it('translates rigid and free boolean restraints into IFC2X3 sentinels', () => {
    const source = "#23=IFCBOUNDARYNODECONDITION($,IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),$,$,$,$);";
    const there = convertStepLine(source, 'IFC4', 'IFC2X3');
    expect(there).toBe('#23=IFCBOUNDARYNODECONDITION($,-1.,0.,$,$,$,$);');
    expect(convertStepLine(there!, 'IFC2X3', 'IFC4')).toContain('IFCBOOLEAN(.T.)');
  });
  it('honors withheld load references before structural remapping', () => {
    const source = "#50=IFCSTRUCTURALLINEARACTION('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);";
    const out = convertStepLine(source, 'IFC4', 'IFC2X3', undefined, undefined, new Set([22]));
    expect(out).not.toContain('#22');
    expect(out).toContain('IFCPROXY');
  });
  for (const type of ['IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION']) {
    it(`${type} keeps projection out of CausedBy and supplies CONST`, () => {
      const source = `#50=${type}('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);`;
      const there = convertStepLine(source, 'IFC2X3', 'IFC4');
      expect(there).toBe(`#50=${type}('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);`);
      expect(convertStepLine(there!, 'IFC4', 'IFC2X3')).toBe(source);
    });
  }
});

// Neither removed field has an EXPRESS slot in the target. The supported
// behavior is an explicit loss warning, never hidden metadata (#9668).
import { EnumReconciliation } from './schema-converter-enums.js';
describe('structural conversion reports unrepresentable data #9668', () => {
  it('reports IFC2X3 point-action CausedBy instead of silently dropping it', () => {
    const diagnostics = new EnumReconciliation();
    const source = "#50=IFCSTRUCTURALPOINTACTION('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,#77);";
    const out = convertStepLine(source, 'IFC2X3', 'IFC4', undefined, undefined, undefined, undefined, diagnostics);
    expect(out).not.toContain('#77');
    expect(diagnostics.warnings().join('\n')).toContain('IFCSTRUCTURALPOINTACTION.CausedBy has no slot in IFC4; its value is omitted');
  });
  it('reports IFC4 point-connection support coordinates lost on downgrade', () => {
    const diagnostics = new EnumReconciliation();
    const source = "#50=IFCSTRUCTURALPOINTCONNECTION('id',#1,$,$,$,$,$,#22,#77);";
    const out = convertStepLine(source, 'IFC4', 'IFC2X3', undefined, undefined, undefined, undefined, diagnostics);
    expect(out).not.toContain('#77');
    expect(diagnostics.warnings().join('\n')).toContain('ConditionCoordinateSystem has no slot in IFC2X3');
    expect(diagnostics.warnings().join('\n')).toContain('restraint directions in that coordinate system are not preserved');
  });
  it('explicitly reports an unsupported IFC2X3 varying action as nonconforming', () => {
    const diagnostics = new EnumReconciliation();
    const source = "#50=IFCSTRUCTURALPLANARACTIONVARYING('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.,#88,(#23));";
    expect(convertStepLine(source, 'IFC2X3', 'IFC4', undefined, undefined, undefined, undefined, diagnostics)).toBe(source);
    expect(diagnostics.warnings().join(' ')).toContain('output does not conform to IFC4');
  });
  it('does not warn about optional schema-only fields when they are unset', () => {
    const diagnostics = new EnumReconciliation();
    convertStepLine("#50=IFCSTRUCTURALPOINTACTION('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$);", 'IFC2X3', 'IFC4', undefined, undefined, undefined, undefined, diagnostics);
    expect(diagnostics.warnings()).toEqual([]);
  });
  it('maps the physical-to-analytical link with the physical product as RelatingProduct', () => {
    const source = "#50=IFCRELCONNECTSSTRUCTURALELEMENT('id',#1,$,$,#22,#77);";
    expect(convertStepLine(source, 'IFC2X3', 'IFC4')).toBe("#50=IFCRELASSIGNSTOPRODUCT('id',#1,$,$,(#77),$,#22);");
  });
});

import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
describe('explicit IFC2X3 section orientation #9668', () => {
  const lines = [
    "#50=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.);",
    '#80=IFCDIRECTION((0.,1.,0.));',
    "#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);",
  ];
  it('uses the explicit z-axis in an ordinary full STEP export', async () => {
    const text = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
    const result = new StepExporter(store).export({ schema: 'IFC4' });
    expect(new TextDecoder().decode(result.content)).toContain("IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.,#80)");
    expect(result.stats.warnings?.join('\n') ?? '').not.toContain('Axis is required');
    const view = new MutablePropertyView(null, 'm');
    view.setAttribute(50, 'Name', 'Ignored edit');
    const sourceOnly = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: false });
    expect(new TextDecoder().decode(sourceOnly.content)).toContain('.RIGID_JOINED_MEMBER.,#80)');
    expect(sourceOnly.stats.warnings.join('\n')).not.toContain('Axis is required');
    // #9845: STEP trivia can precede the tuple as well as follow its numbers.
    for (const tuple of ['((0.,1./* axis */,0.))', '(/* axis */(0.,1.,0.))']) {
      const commentedStore = await new IfcParser().parseColumnar(new TextEncoder().encode(text.replace('((0.,1.,0.))', tuple)).buffer);
      const commented = new StepExporter(commentedStore).export({ schema: 'IFC4' });
      expect(new TextDecoder().decode(commented.content)).toContain('.RIGID_JOINED_MEMBER.,#80)');
      expect(commented.stats.warnings.join('\n')).not.toContain('Axis is required');
    }
  });
  it('refuses to guess a section axis from a placed or ambiguous member', () => {
    const diagnostics = new EnumReconciliation();
    lines.forEach(line => diagnostics.structural.axes.note(line));
    expect(diagnostics.structural.axes.axis(lines[0].replace('$,$,$,$,$,.RIGID', '$,$,$,#99,$,.RIGID'))).toBeUndefined();
    diagnostics.structural.axes.note(lines[2].replace('#90=', '#91=').replace('#80);', '#82);'));
    expect(diagnostics.structural.axes.axis(lines[0])).toBeUndefined();
  });
});

import { analyzeConversionLoss, classifyEntityTypeConversion } from './schema-conversion-loss-report.js';
describe('boundary conversion loss preview #9668 review regression', () => {
  it('does not report renamed stiffness fields as dropped in either direction', () => {
    for (const type of ['IFCBOUNDARYNODECONDITION', 'IFCBOUNDARYNODECONDITIONWARPING', 'IFCBOUNDARYEDGECONDITION', 'IFCBOUNDARYFACECONDITION']) {
      for (const [from, to] of [['IFC2X3', 'IFC4'], ['IFC4', 'IFC2X3']] as const) {
        expect(classifyEntityTypeConversion(type, from, to)).toEqual({ targetType: type, kind: from === 'IFC4' ? 'lossy' : 'renamed', droppedAttributes: [] });
      }
    }
  });
  it('reports no loss for a populated boundary store that exports the same stiffness values', async () => {
    const source = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#23=IFCBOUNDARYNODECONDITION('Support',12.,23.,34.,45.,56.,67.);\nENDSEC;\nEND-ISO-10303-21;";
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
    expect(analyzeConversionLoss(store, 'IFC2X3', 'IFC4').hasLoss).toBe(false);
    const out = new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC4' }).content);
    expect(out).toContain('IFCLINEARSTIFFNESSMEASURE(12.)');
    expect(out).toContain('IFCROTATIONALSTIFFNESSMEASURE(67.)');
  });
  it('reports the IFC4 SELECT member lost when boolean false and zero measure collapse #9845', async () => {
    const line = "#23=IFCBOUNDARYEDGECONDITION('Support',IFCBOOLEAN(.F.),IFCMODULUSOFLINEARSUBGRADEREACTIONMEASURE(0.),$,$,$,$);";
    const source = `ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${line}\nENDSEC;\nEND-ISO-10303-21;`;
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
    const report = analyzeConversionLoss(store, 'IFC4', 'IFC2X3');
    expect(report.hasLoss).toBe(true);
    expect(report.entries).toMatchObject([{ sourceType: 'IFCBOUNDARYEDGECONDITION', kind: 'lossy', droppedAttributes: [] }]);
    expect(new TextDecoder().decode(new StepExporter(store).export({ schema: 'IFC2X3' }).content)).toContain("IFCBOUNDARYEDGECONDITION('Support',0.,0.,$,$,$,$)");
    const there = convertStepLine(line, 'IFC4', 'IFC2X3');
    expect(convertStepLine(there!, 'IFC2X3', 'IFC4')).not.toContain('IFCBOOLEAN(.F.)');
  });
});


describe('STEP trivia in structural stiffness values #9668 review regressions', () => {
  it('keeps commented numeric -1 rigid and retains finite measures', () => {
    const out = convertStepLine('#23=IFCBOUNDARYNODECONDITION($,-1./* rigid */,12./* finite */,$,$,$,$);', 'IFC2X3', 'IFC4');
    expect(out).toContain('IFCBOOLEAN(.T.)');
    expect(out).toContain('IFCLINEARSTIFFNESSMEASURE(12./* finite */)');
  });
  for (const typed of ['IFCBOOLEAN (.T.)', 'IFCBOOLEAN/*type*/( /*value*/ .T. /*tail*/ )', 'ifcboolean ( .t. )']) {
    it(`unwraps ${typed} using the STEP slot grammar`, () => {
      expect(convertStepLine(`#23=IFCBOUNDARYNODECONDITION($,${typed},$,$,$,$,$);`, 'IFC4', 'IFC2X3'))
        .toBe('#23=IFCBOUNDARYNODECONDITION($,-1.,$,$,$,$,$);');
    });
  }
});


describe('irreversible structural relationship preview #9668 review regression', () => {
  it('does not claim an assignment when a withheld endpoint forces a proxy #9845', () => {
    const diagnostics = new EnumReconciliation();
    const source = "#50=IFCRELCONNECTSSTRUCTURALELEMENT('id',#1,$,$,#22,#77);";
    const out = convertStepLine(source, 'IFC2X3', 'IFC4', undefined, undefined, new Set([22]), undefined, diagnostics);
    expect(out).toContain('IFCPROXY');
    expect(out).not.toContain('#22');
    expect(diagnostics.warnings().join(' ')).not.toContain('mapped to IfcRelAssignsToProduct');
  });
  it('reports the lost relationship kind while retaining both linked objects', async () => {
    const source = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;\n#50=IFCRELCONNECTSSTRUCTURALELEMENT('id',#1,$,$,#22,#77);\nENDSEC;\nEND-ISO-10303-21;";
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer);
    for (const target of ['IFC4', 'IFC4X3', 'IFC5'] as const) {
      const report = analyzeConversionLoss(store, 'IFC2X3', target);
      expect(report.hasLoss).toBe(true);
      expect(report.entries).toMatchObject([{ sourceType: 'IFCRELCONNECTSSTRUCTURALELEMENT', targetType: 'IFCRELASSIGNSTOPRODUCT', kind: 'lossy', droppedAttributes: [] }]);
      const diagnostics = new EnumReconciliation();
      expect(convertStepLine("#50=IFCRELCONNECTSSTRUCTURALELEMENT('id',#1,$,$,#22,#77);", 'IFC2X3', target, undefined, undefined, undefined, undefined, diagnostics))
        .toBe("#50=IFCRELASSIGNSTOPRODUCT('id',#1,$,$,(#77),$,#22);");
      expect(diagnostics.warnings().join(' ' )).toContain('original relationship kind cannot round trip');
    }
  });
});
