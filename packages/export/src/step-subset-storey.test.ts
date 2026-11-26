/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseStep, selectSubsetSeeds } from './step-subset.js';
import { productsUnderPlacement, resolveStorey } from './step-subset-storey.js';

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

describe('selectSubsetSeeds: storey members by containment, not only by placement', () => {
  it('seeds an element contained in the storey even when it is placed in world coordinates', () => {
    const text = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#10=IFCLOCALPLACEMENT($,#2);', '#11=IFCLOCALPLACEMENT($,#2);',
      "#20=IFCBUILDINGSTOREY('0000000000000000000ST0',$,'L1',$,$,#10,$,$,.ELEMENT.,0.);",
      "#30=IFCWALL('0000000000000000000WA0',$,'W',$,$,#11,$,$,$);",
      "#40=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC0',$,$,$,(#30),#20);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const seeds = selectSubsetSeeds(parseStep(text), { storeys: ['L1'], requireEachMatch: true });
    expect([...seeds].sort((a, b) => a - b)).toEqual([20, 30]);
  });
});

describe('selectSubsetSeeds: storeys that share one placement', () => {
  it('selects only the asked-for storey and what it contains', () => {
    const text = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);', '#50=IFCLOCALPLACEMENT($,#2);',
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
      "#42=IFCBUILDINGSTOREY('0000000000000000000ST2',$,'L02',$,$,#40,$,$,.ELEMENT.,3.);",
      "#70=IFCWALL('0000000000000000000WA1',$,'W1',$,$,#50,$,$,$);",
      "#71=IFCWALL('0000000000000000000WA2',$,'W2',$,$,#50,$,$,$);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#41);",
      "#81=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC2',$,$,$,(#71),#42);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect([...selectSubsetSeeds(parseStep(text), { storeys: ['L01'] })].sort((a, b) => a - b)).toEqual([41, 70]);
  });

  it('keeps a wall placed on the shared placement with the storey that contains it', () => {
    const shared = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);', '#60=IFCLOCALPLACEMENT(#40,#2);', '#61=IFCLOCALPLACEMENT(#40,#2);',
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
      "#42=IFCBUILDINGSTOREY('0000000000000000000ST2',$,'L02',$,$,#40,$,$,.ELEMENT.,3.);",
      "#70=IFCWALL('0000000000000000000WA1',$,'W1',$,$,#60,$,$,$);",
      "#71=IFCWALL('0000000000000000000WA2',$,'W2',$,$,#61,$,$,$);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#41);",
      "#81=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC2',$,$,$,(#71),#42);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect([...selectSubsetSeeds(parseStep(shared), { storeys: ['L01'] })].sort((a, b) => a - b)).toEqual([41, 70]);
  });

  it('keeps an element contained in a space under the storey', () => {
    const spaced = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);', '#45=IFCLOCALPLACEMENT(#40,#2);', '#46=IFCLOCALPLACEMENT(#45,#2);',
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
      "#50=IFCSPACE('0000000000000000000SP1',$,'Room',$,$,#45,$,$,.ELEMENT.,.INTERNAL.,$);",
      "#70=IFCFURNISHINGELEMENT('0000000000000000000FU1',$,'Chair',$,$,#46,$,$);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#50);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect([...selectSubsetSeeds(parseStep(spaced), { storeys: ['L01'] })].sort((a, b) => a - b)).toEqual([41, 50, 70]);
  });

  it('follows spaces a storey aggregates, and leaves another storey\'s spaces out', () => {
    const tree = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#50=IFCLOCALPLACEMENT($,#2);', '#51=IFCLOCALPLACEMENT(#50,#2);', '#52=IFCLOCALPLACEMENT($,#2);',
      "#100=IFCBUILDINGSTOREY('0000000000000000000STA',$,'A',$,$,#50,$,$,.ELEMENT.,0.);",
      "#200=IFCBUILDINGSTOREY('0000000000000000000STB',$,'B',$,$,#50,$,$,.ELEMENT.,3.);",
      "#300=IFCSPACE('0000000000000000000SPA',$,'Room',$,$,#51,$,$,.ELEMENT.,.INTERNAL.,$);",
      "#310=IFCRELAGGREGATES('0000000000000000000AGA',$,$,$,#100,(#300));",
      "#400=IFCWALL('0000000000000000000WA4',$,'W',$,$,#51,$,$,$);",
      "#500=IFCFURNISHINGELEMENT('0000000000000000000FU5',$,'Chair',$,$,#52,$,$);",
      "#410=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RCS',$,$,$,(#400,#500),#300);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const parsed = parseStep(tree);
    // B shares A's placement, but the space and its contents belong to A.
    expect([...selectSubsetSeeds(parsed, { storeys: ['B'] })]).toEqual([200]);
    // The world-placed chair is A's through its space.
    expect([...selectSubsetSeeds(parsed, { storeys: ['A'] })].sort((a, b) => a - b)).toEqual([100, 300, 400, 500]);
  });

  it('does not treat a spatial reference as ownership', () => {
    const ref = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#50=IFCLOCALPLACEMENT($,#2);', '#60=IFCLOCALPLACEMENT($,#2);', '#52=IFCLOCALPLACEMENT($,#2);',
      "#100=IFCBUILDINGSTOREY('0000000000000000000STA',$,'A',$,$,#50,$,$,.ELEMENT.,0.);",
      "#200=IFCBUILDINGSTOREY('0000000000000000000STB',$,'B',$,$,#60,$,$,.ELEMENT.,3.);",
      "#400=IFCCOLUMN('0000000000000000000CO4',$,'C',$,$,#52,$,$,$);",
      "#410=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC4',$,$,$,(#400),#100);",
      "#420=IFCRELREFERENCEDINSPATIALSTRUCTURE('0000000000000000000RF4',$,$,$,(#400),#200);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const parsed = parseStep(ref);
    expect([...selectSubsetSeeds(parsed, { storeys: ['A'] })].sort((a, b) => a - b)).toEqual([100, 400]);
    expect([...selectSubsetSeeds(parsed, { storeys: ['B'] })]).toEqual([200]);
  });

  it('keeps an opening with its host storey, not a storey that shares the placement', () => {
    const voids = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);', '#50=IFCLOCALPLACEMENT(#40,#2);', '#51=IFCLOCALPLACEMENT(#50,#2);',
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
      "#42=IFCBUILDINGSTOREY('0000000000000000000ST2',$,'L02',$,$,#40,$,$,.ELEMENT.,3.);",
      "#70=IFCWALL('0000000000000000000WA1',$,'W1',$,$,#50,$,$,$);",
      "#71=IFCWALL('0000000000000000000WA2',$,'W2',$,$,#50,$,$,$);",
      "#72=IFCOPENINGELEMENT('0000000000000000000OP1',$,'O',$,$,#51,$,$,$);",
      "#73=IFCRELVOIDSELEMENT('0000000000000000000RV1',$,$,$,#70,#72);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#41);",
      "#81=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC2',$,$,$,(#71),#42);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const parsed = parseStep(voids);
    expect([...selectSubsetSeeds(parsed, { storeys: ['L02'] })].sort((a, b) => a - b)).toEqual([42, 71]);
    expect([...selectSubsetSeeds(parsed, { storeys: ['L01'] })].sort((a, b) => a - b)).toEqual([41, 70, 72]);
  });

  it('keeps a world-placed opening with its host storey', () => {
    const world = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);', '#50=IFCLOCALPLACEMENT(#40,#2);', '#60=IFCLOCALPLACEMENT($,#2);',
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
      "#70=IFCWALL('0000000000000000000WA1',$,'W1',$,$,#50,$,$,$);",
      "#72=IFCOPENINGELEMENT('0000000000000000000OP1',$,'O',$,$,#60,$,$,$);",
      "#73=IFCRELVOIDSELEMENT('0000000000000000000RV1',$,$,$,#70,#72);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#41);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect([...selectSubsetSeeds(parseStep(world), { storeys: ['L01'] })].sort((a, b) => a - b)).toEqual([41, 70, 72]);
  });

  it('includes the elements of a storey the selected storey aggregates', () => {
    const nested = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#10=IFCLOCALPLACEMENT($,#2);', '#20=IFCLOCALPLACEMENT(#10,#2);', '#30=IFCLOCALPLACEMENT(#20,#2);',
      "#100=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'Level 1',$,$,#10,$,$,.ELEMENT.,0.);",
      "#200=IFCBUILDINGSTOREY('0000000000000000000ST2',$,'Mezzanine',$,$,#20,$,$,.PARTIAL.,1.5);",
      "#210=IFCRELAGGREGATES('0000000000000000000AG1',$,$,$,#100,(#200));",
      "#300=IFCWALL('0000000000000000000WA3',$,'W',$,$,#30,$,$,$);",
      "#310=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC3',$,$,$,(#300),#200);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    const parsed = parseStep(nested);
    expect([...selectSubsetSeeds(parsed, { storeys: ['Level 1'] })].sort((a, b) => a - b)).toEqual([100, 300]);
    expect([...selectSubsetSeeds(parsed, { storeys: ['Mezzanine'] })].sort((a, b) => a - b)).toEqual([200, 300]);
  });

  it('never counts a building that shares the storey placement as one of its products', () => {
    const building = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
      '#40=IFCLOCALPLACEMENT($,#2);',
      "#30=IFCBUILDING('0000000000000000000BLD',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);",
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L0',$,$,#40,$,$,.ELEMENT.,0.);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect(() => selectSubsetSeeds(parseStep(building), { storeys: ['L0'], requireEachMatch: true })).toThrow(/Storey L0 has no elements/);
  });
});

describe('resolveStorey: a storey NAMED with a number', () => {
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
    expect(resolveStorey('1', parsed).placementId).toBe(11);
    expect(resolveStorey('0', parsed).placementId).toBe(10);
  });

  it('matches the Name attribute, and refuses a name two storeys share', () => {
    const shared = parseStep(text.replace("'0',$,$,#10", "'1',$,$,#10"));
    expect(() => resolveStorey('1', shared).placementId).toThrow(/2 storeys are named '1'/);
    const described = parseStep(text.replace("'0',$,$,#10", "'Ground','1',$,#10"));
    expect(resolveStorey('1', described).placementId).toBe(11);
  });

  it('falls back to LongName when no Name matches, never to Description', () => {
    const revit = parseStep(text.replace("'0',$,$,#10,$,$,.ELEMENT.", "'02','Level 2 notes',$,#10,$,'Level 2',.ELEMENT."));
    expect(resolveStorey('Level 2', revit).placementId).toBe(10);
    expect(() => resolveStorey('Level 2 notes', revit).placementId).toThrow(/Storey not found/);
  });

  it('reads a Name written as raw UTF-8 bytes (the parse is latin1)', () => {
    const latin1 = Buffer.from(text.replace("'0',$,$,#10", "'Erdgeschoß',$,$,#10"), 'utf8').toString('latin1');
    expect(resolveStorey('Erdgeschoß', parseStep(latin1)).placementId).toBe(10);
  });

  it('keeps an escaped Latin-1 Name as written', () => {
    const escaped = parseStep(text.replace("'0',$,$,#10", "'\\X\\C3\\X\\A9tage',$,$,#10"));
    expect(resolveStorey('\u00c3\u00a9tage', escaped).placementId).toBe(10);
  });

  it('decodes the Name before comparing (doubled quote, \\X2\\ escape)', () => {
    const named = parseStep(text.replace("'0',$,$,#10", "'O''Brien \\X2\\00FC\\X0\\',$,$,#10"));
    expect(resolveStorey("O'Brien \u00fc", named).placementId).toBe(10);
  });

  it('refuses a bare number that is one storey\'s id and another storey\'s Name', () => {
    const clash = parseStep(text.replace("'0',$,$,#10", "'21',$,$,#10"));
    expect(() => resolveStorey('21', clash).placementId).toThrow(/storey #21 and the Name of storey #20/);
    expect(resolveStorey('#21', clash).placementId).toBe(11);
  });

  it('reports a storey id whose number other storeys share as a Name as ambiguous, not as a duplicate name', () => {
    const clash = parseStep(text.replace("'0',$,$,#10", "'20',$,$,#10").replace("'1',$,$,#11", "'20',$,$,#11"));
    expect(() => resolveStorey('20', clash).placementId).toThrow(/is storey #20 and the Name of other storeys/);
  });

  it('still reads a bare storey express id, and #id, as an id', () => {
    expect(resolveStorey('20', parsed).placementId).toBe(10);
    expect(resolveStorey('#21', parsed).placementId).toBe(11);
    expect(() => resolveStorey('#1', parsed).placementId).toThrow(/IFCPROJECT, not an IfcBuildingStorey/);
  });
});

describe('parseStep: GlobalId index', () => {
  it('indexes IfcRoot records only, whatever the record order', () => {
    const text = [
      'ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;',
      "#5=IFCPROPERTYSINGLEVALUE('2O2Fr$t4X7Zf8NOew3FLKr',$,$,$);",
      "#10=IFCWALL('2O2Fr$t4X7Zf8NOew3FLKr',$,'W',$,$,$,$,$,$);",
      "#900=IFCPROPERTYSINGLEVALUE('2O2Fr$t4X7Zf8NOew3FLKr',$,$,$);",
      'ENDSEC;', 'END-ISO-10303-21;', '',
    ].join('\n');
    expect(parseStep(text).guidToId.get('2O2Fr$t4X7Zf8NOew3FLKr')).toBe(10);
  });
});
