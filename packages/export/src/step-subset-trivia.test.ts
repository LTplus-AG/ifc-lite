/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP trivia and IFC shapes the subset engine has to read right (PR #11583
 * review): comments between and inside records, `DATA;` framing, relation
 * anchors read from their slot, projections, and storeys whose members are
 * not on the storey's placement chain.
 */

import { describe, expect, it } from 'vitest';
import { buildSubset, parseStep, selectSubsetSeeds, serializeSubset } from './step-subset.js';

const file = (records: string[], header = "FILE_SCHEMA(('IFC4'));"): string =>
  ['ISO-10303-21;', 'HEADER;', header, 'ENDSEC;', 'DATA;', ...records, 'ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');

const BASE = [
  '#2=IFCAXIS2PLACEMENT3D(#3,$,$);', '#3=IFCCARTESIANPOINT((0.,0.,0.));',
  '#40=IFCLOCALPLACEMENT($,#2);', '#50=IFCLOCALPLACEMENT(#40,#2);', '#60=IFCLOCALPLACEMENT($,#2);',
  "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);",
];
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe('parseStep framing', () => {
  it('reads a record on the same line as DATA;', () => {
    const text = file([]).replace('DATA;\n', "DATA;#10=IFCWALL('0000000000000000000WA1',$,'W',$,$,$,$,$,$);\n");
    const parsed = parseStep(text);
    expect([...parsed.instances.keys()]).toEqual([10]);
    expect(serializeSubset(buildSubset(new Set([10]), parsed), parsed)).toMatch(/DATA;\n#10=IFCWALL/);
  });

  it('ignores DATA; inside a header string', () => {
    const text = file(["#10=IFCWALL('0000000000000000000WA1',$,'W',$,$,$,$,$,$);"], "FILE_DESCRIPTION(('has DATA; inside'),'2;1');");
    expect([...parseStep(text).instances.keys()]).toEqual([10]);
  });

  it('treats comments between and inside records as trivia', () => {
    const text = file([
      "#10=IFCWALL('0000000000000000000WA1',$,'W',$,$,$,$,$,$);",
      '/* ENDSEC; is not the end */',
      "#11=IFCWALL('0000000000000000000WA2',$,'W2' /* a ) and a ' in a comment */,$,$,$,$,$,$);",
      "#12=IFCWALL('0000000000000000000WA3',$,'W3',$,$,$,$,$,$);",
    ]);
    const parsed = parseStep(text);
    expect([...parsed.instances.keys()]).toEqual([10, 11, 12]);
    expect(parsed.instances.get(12)?.type).toBe('IFCWALL');
  });
});

describe('relation anchors and projections', () => {
  it('reads a void relation anchor from its slot, not the last ids in the body', () => {
    const text = file([
      ...BASE,
      "#70=IFCWALL('0000000000000000000WA1',$,'W',$,$,#50,$,$,$);",
      "#103=IFCOPENINGELEMENT('0000000000000000000OP1',$,'O',$,$,#50,$,$,$);",
      "#999=IFCWALL('0000000000000000000WA9',$,'X',$,$,#50,$,$,$);",
      "#80=IFCRELVOIDSELEMENT('0000000000000000000RV1',$,$,$,#70,#103 /* opening #999 */);",
    ]);
    const parsed = parseStep(text);
    const keep = buildSubset(new Set([70]), parsed).keep;
    expect(keep.has(80)).toBe(true);
    expect(keep.has(103)).toBe(true);
    expect(keep.has(999)).toBe(false);
  });

  it('keeps the projection relation with its host', () => {
    const text = file([
      ...BASE,
      "#70=IFCWALL('0000000000000000000WA1',$,'W',$,$,#50,$,$,$);",
      "#71=IFCPROJECTIONELEMENT('0000000000000000000PR1',$,'P',$,$,#50,$,$,$);",
      "#81=IFCRELPROJECTSELEMENT('0000000000000000000RP1',$,$,$,#70,#71);",
    ]);
    const parsed = parseStep(text);
    const keep = buildSubset(new Set([70]), parsed).keep;
    expect(keep.has(81)).toBe(true);
    expect(keep.has(71)).toBe(true);
  });
});

describe('storey members off the placement chain', () => {
  it('reads containment with comments around the references', () => {
    const text = file([
      ...BASE,
      "#70=IFCWALL('0000000000000000000WA1',$,'W',$,$,#60,$,$,$);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(/* wall */#70),/* level */#41);",
    ]);
    expect(sorted(selectSubsetSeeds(parseStep(text), { storeys: ['L01'] }))).toEqual([41, 70]);
  });

  it('selects by containment for a storey with no placement', () => {
    const text = file([
      ...BASE.filter((r) => !r.startsWith('#41=')),
      "#41=IFCBUILDINGSTOREY('0000000000000000000ST1',$,'L01',$,$,$,$,$,.ELEMENT.,0.);",
      "#70=IFCWALL('0000000000000000000WA1',$,'W',$,$,#60,$,$,$);",
      "#80=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000RC1',$,$,$,(#70),#41);",
    ]);
    expect(sorted(selectSubsetSeeds(parseStep(text), { storeys: ['L01'], requireEachMatch: true }))).toEqual([41, 70]);
  });

  it('brings a world-placed part of an assembly the placement pass took', () => {
    const text = file([
      ...BASE,
      "#70=IFCELEMENTASSEMBLY('0000000000000000000EA1',$,'A',$,$,#50,$,$,$,$);",
      "#71=IFCBEAM('0000000000000000000BM1',$,'B',$,$,#60,$,$,$);",
      "#82=IFCRELAGGREGATES('0000000000000000000AG1',$,$,$,#70,(#71));",
    ]);
    expect(sorted(selectSubsetSeeds(parseStep(text), { storeys: ['L01'] }))).toEqual([41, 70, 71]);
  });
});
