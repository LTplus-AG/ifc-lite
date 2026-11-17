/* SPDX-License-Identifier: MPL-2.0 */
import { describe, expect, it } from 'vitest';
import { listItems, StructuralAxes } from './schema-converter-structural-axes.js';
import { slotRef, slotUnset } from './schema-converter-structural-source.js';

// #9668 review (PR #10551): optional slots reach these readers as undefined
// when a source record is unreadable or shorter than expected.
describe('structural slot readers #9668', () => {
  it('reads a missing slot as no reference', () => {
    expect(slotRef(undefined)).toBeNull();
    expect(slotRef('')).toBeNull();
  });

  it('reads a missing slot as set, not unset', () => {
    expect(slotUnset(undefined)).toBe(false);
  });

  it('reads references and $ beside STEP comments, and rejects trailing text (#10248)', () => {
    expect(slotRef('#20')).toBe(20);
    expect(slotRef(' /* c */ #20 /* d */')).toBe(20);
    expect(slotRef('#20 x')).toBeNull();
    expect(slotUnset(' $ /* none */')).toBe(true);
    expect(slotUnset('$ x')).toBe(false);
  });

  it('reads a missing list as no list', () => {
    expect(listItems(undefined)).toBeNull();
  });
});

// #9668 review (PR #10551): the axes prepass reads references beside STEP comments (#10248).
describe('StructuralAxes references beside STEP comments #9668', () => {
  it('finds the axis of a member named with comments', () => {
    // As schema-converter-structural-r2.test.ts's section-axis fixture.
    const member = "#50=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$,$,.RIGID_JOINED_MEMBER.);";
    const axis = (rel: string) => {
      const axes = new StructuralAxes();
      axes.note('#80=IFCDIRECTION((0.,1.,0.));');
      axes.note(rel);
      return axes.axis(member);
    };
    expect(axis("#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);")).toBe('#80');
    expect(axis("#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50 /* member */),#81,$,#80 /* axis */);")).toBe('#80');
  });

  it('reads a commented unset placement as unplaced', () => {
    const axes = new StructuralAxes();
    axes.note('#80=IFCDIRECTION((0.,1.,0.));');
    axes.note("#90=IFCRELASSOCIATESPROFILEPROPERTIES('3Npn749xX3h8J7ezZM_AKg',#1,$,$,(#50),#81,$,#80);");
    expect(axes.axis("#50=IFCSTRUCTURALCURVEMEMBER('0XciGbSFPUkgAKmWK4M6tc',#1,$,$,$,$ /* placement */,$,.RIGID_JOINED_MEMBER.);")).toBe('#80');
  });
});
