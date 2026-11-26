/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseStep } from './step-subset.js';
import { productsUnderPlacement, resolveStoreyPlacement } from './step-subset-storey.js';

/** A storey placement #1000, `depth` nested placements below it, and a wall on the deepest. */
function nested(depth: number, cycle = false): string {
  const lines = ['#1000=IFCLOCALPLACEMENT($,#1);', '#1=IFCAXIS2PLACEMENT3D(#2,$,$);', '#2=IFCCARTESIANPOINT((0.,0.,0.));'];
  for (let i = 1; i <= depth; i++) lines.push(`#${1000 + i}=IFCLOCALPLACEMENT(#${1000 + i - 1},#1);`);
  if (cycle) lines[0] = `#1000=IFCLOCALPLACEMENT(#${1000 + depth},#1);`;
  lines.push(`#9000=IFCWALL('0000000000000000000000',$,'w',$,$,#${1000 + depth},$,$,$);`);
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

describe('productsUnderPlacement (#7791, D27: no depth guard)', () => {
  it('finds a product nested 300 placements below the storey (the old guard stopped at 128)', () => {
    expect(productsUnderPlacement(1000, parseStep(nested(300))).has(9000)).toBe(true);
  });

  it('does not select a product whose chain cycles without reaching the storey', () => {
    // #1001 points past the storey to #1003, so #1001..#1003 form a cycle that
    // never reaches #1000.
    const text = nested(3).replace('#1001=IFCLOCALPLACEMENT(#1000,#1);', '#1001=IFCLOCALPLACEMENT(#1003,#1);');
    expect(productsUnderPlacement(1000, parseStep(text)).has(9000)).toBe(false);
  });
});

describe('resolveStoreyPlacement: a storey NAMED with a number', () => {
  const text = [
    'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
    "#1=IFCPROJECT('0000000000000000000PRJ',$,'P',$,$,$,$,$,$);",
    '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
    '#10=IFCLOCALPLACEMENT($,#2);', '#11=IFCLOCALPLACEMENT($,#2);',
    "#20=IFCBUILDINGSTOREY('0000000000000000000ST0',$,'0',$,$,#10,$,$,.ELEMENT.,0.);",
    "#21=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'1',$,$,#11,$,$,.ELEMENT.,3.);",
    'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const parsed = parseStep(text);

  it('reads a bare number that is no storey id as a name', () => {
    expect(resolveStoreyPlacement('1', parsed)).toBe(11);
    expect(resolveStoreyPlacement('0', parsed)).toBe(10);
  });

  it('matches the Name attribute, and refuses a name two storeys share', () => {
    const shared = parseStep(text.replace("'0',$,$,#10", "'1',$,$,#10"));
    expect(() => resolveStoreyPlacement('1', shared)).toThrow(/2 storeys are named '1'/);
    const described = parseStep(text.replace("'0',$,$,#10", "'Ground','1',$,#10"));
    expect(resolveStoreyPlacement('1', described)).toBe(11);
  });

  it('falls back to LongName when no Name matches, never to Description', () => {
    const revit = parseStep(text.replace("'0',$,$,#10,$,$,.ELEMENT.", "'02','Level 2 notes',$,#10,$,'Level 2',.ELEMENT."));
    expect(resolveStoreyPlacement('Level 2', revit)).toBe(10);
    expect(() => resolveStoreyPlacement('Level 2 notes', revit)).toThrow(/Storey not found/);
  });

  it('reads a Name written as raw UTF-8 bytes (the parse is latin1)', () => {
    const latin1 = Buffer.from(text.replace("'0',$,$,#10", "'Erdgeschoß',$,$,#10"), 'utf8').toString('latin1');
    expect(resolveStoreyPlacement('Erdgeschoß', parseStep(latin1))).toBe(10);
  });

  it('keeps an escaped Latin-1 Name as written', () => {
    const escaped = parseStep(text.replace("'0',$,$,#10", "'\\X\\C3\\X\\A9tage',$,$,#10"));
    expect(resolveStoreyPlacement('\u00c3\u00a9tage', escaped)).toBe(10);
  });

  it('decodes the Name before comparing (doubled quote, \\X2\\ escape)', () => {
    const named = parseStep(text.replace("'0',$,$,#10", "'O''Brien \\X2\\00FC\\X0\\',$,$,#10"));
    expect(resolveStoreyPlacement("O'Brien \u00fc", named)).toBe(10);
  });

  it('refuses a bare number that is one storey\'s id and another storey\'s Name', () => {
    const clash = parseStep(text.replace("'0',$,$,#10", "'21',$,$,#10"));
    expect(() => resolveStoreyPlacement('21', clash)).toThrow(/storey #21 and the Name of storey #20/);
    expect(resolveStoreyPlacement('#21', clash)).toBe(11);
  });

  it('still reads a bare storey express id, and #id, as an id', () => {
    expect(resolveStoreyPlacement('20', parsed)).toBe(10);
    expect(resolveStoreyPlacement('#21', parsed)).toBe(11);
    expect(() => resolveStoreyPlacement('#1', parsed)).toThrow(/IFCPROJECT, not an IfcBuildingStorey/);
  });
});
