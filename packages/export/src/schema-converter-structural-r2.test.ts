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
  });
  it('refuses to guess a section axis from a placed or ambiguous member', () => {
    const diagnostics = new EnumReconciliation();
    lines.forEach(line => diagnostics.structural.axes.note(line));
    expect(diagnostics.structural.axes.axis(lines[0].replace('$,$,$,$,$,.RIGID', '$,$,$,#99,$,.RIGID'))).toBeUndefined();
    diagnostics.structural.axes.note(lines[2].replace('#90=', '#91=').replace('#80);', '#82);'));
    expect(diagnostics.structural.axes.axis(lines[0])).toBeUndefined();
  });
});
