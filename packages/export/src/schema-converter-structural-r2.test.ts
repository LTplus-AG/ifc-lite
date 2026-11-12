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
  for (const type of ['IFCSTRUCTURALLINEARACTION', 'IFCSTRUCTURALPLANARACTION']) {
    it(`${type} keeps projection out of CausedBy and supplies CONST`, () => {
      const source = `#50=${type}('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,$,.TRUE_LENGTH.);`;
      const there = convertStepLine(source, 'IFC2X3', 'IFC4');
      expect(there).toBe(`#50=${type}('id',#1,$,$,$,$,$,#22,.GLOBAL_COORDS.,.F.,.TRUE_LENGTH.,.CONST.);`);
      expect(convertStepLine(there!, 'IFC4', 'IFC2X3')).toBe(source);
    });
  }
});
