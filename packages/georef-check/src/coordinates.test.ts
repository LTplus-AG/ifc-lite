/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The coordinate probe (PR #10386 review, findings 1 and 11): families are
 * measured apart, placement Locations are not geometry, and a point list of
 * any size costs one bounded read.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import {
  MAX_SAMPLED_POINT_LISTS,
  POINT_LIST_PREFIX_BYTES,
  samplePointFamilies,
  tuplesFromRecordPrefix,
  type EntityReader,
} from './coordinates.js';
import { collectGeorefFacts, firstReferenceIn } from './facts-from-store.js';
import { diagnoseGeoreference } from './diagnose.js';

function stepFile(data: string[]): ArrayBuffer {
  return new TextEncoder().encode([
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('probe.ifc','2026-11-15T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    ...data, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n')).buffer as ArrayBuffer;
}

describe('a large point list', () => {
  it('a mesh of several MB in map coordinates is read (a prefix of it) and keeps a correct model clean', async () => {
    // One IfcCartesianPointList3D of 120,000 LV95 tuples (about 4 MB, past the
    // old 2 MB skip), 300 small local points, and a zero-offset conversion.
    const tuples: string[] = [];
    for (let i = 0; i < 120_000; i++) tuples.push(`(${(2_600_000 + (i % 400) * 0.5).toFixed(3)},${(1_199_650 + Math.floor(i / 400) * 0.5).toFixed(3)},540.125)`);
    const local = Array.from({ length: 300 }, (_, i) => `#${100 + i}=IFCCARTESIANPOINT((${i % 30}.,${Math.floor(i / 30)}.,0.));`);
    const data = [
      '#1=IFCCARTESIANPOINT((0.,0.,0.));', '#2=IFCAXIS2PLACEMENT3D(#1,$,$);',
      "#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);",
      '#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#5=IFCUNITASSIGNMENT((#4));',
      "#6=IFCPROJECT('0GeorefProbe0000000001',$,'p',$,$,$,$,(#3),#5);",
      '#7=IFCLOCALPLACEMENT($,#2);',
      "#8=IFCSITE('0GeorefProbe0000000002',$,'Site',$,$,#7,$,$,.ELEMENT.,$,$,$,$,$);",
      "#9=IFCPROJECTEDCRS('EPSG:2056',$,$,'EPSG:5728',$,$,#4);",
      '#10=IFCMAPCONVERSION(#3,#9,0.,0.,0.,1.,0.,1.);',
      `#11=IFCCARTESIANPOINTLIST3D((${tuples.join(',')}),$);`,
      ...local,
    ];
    const buffer = stepFile(data);
    expect(buffer.byteLength).toBeGreaterThan(3 * 1024 * 1024);
    const store = await new IfcParser().parseColumnar(buffer);
    const facts = collectGeorefFacts(store);
    expect(facts?.coordinates?.geometry?.pointLists?.median.x).toBeGreaterThan(2_500_000);
    expect(facts?.coordinates?.geometry?.cartesianPoints?.median.x).toBeLessThan(100);
    const report = diagnoseGeoreference(facts as NonNullable<typeof facts>);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });
});

/** A reader over synthetic records that counts how much it was asked to read. */
function syntheticReader(listCount: number, tuplesPerList = 3) {
  const reads: Array<{ id: number; maxBytes: number }> = [];
  const lists = Array.from({ length: listCount }, (_, i) => 1000 + i);
  const record = (id: number) => `#${id}=IFCCARTESIANPOINTLIST3D((${Array.from({ length: tuplesPerList }, (_, k) => `(${k}.,${id}.,0.)`).join(',')}),$);`;
  const reader: EntityReader = {
    get: () => undefined,
    idsOfType: (type) => (type === 'IFCCARTESIANPOINTLIST3D' ? lists : []),
    recordPrefix(id, maxBytes) {
      reads.push({ id, maxBytes });
      return record(id).slice(0, maxBytes);
    },
  };
  return { reader, reads };
}

describe(`at most ${MAX_SAMPLED_POINT_LISTS} point lists, each one bounded read`, () => {
  it(`${MAX_SAMPLED_POINT_LISTS} lists: every one is read`, () => {
    const { reader, reads } = syntheticReader(MAX_SAMPLED_POINT_LISTS);
    samplePointFamilies(reader, 2048, new Map());
    expect(reads).toHaveLength(MAX_SAMPLED_POINT_LISTS);
  });
  it(`${MAX_SAMPLED_POINT_LISTS + 1} lists: still ${MAX_SAMPLED_POINT_LISTS} reads, strided over all of them`, () => {
    const { reader, reads } = syntheticReader(MAX_SAMPLED_POINT_LISTS * 3 + 1);
    samplePointFamilies(reader, 2048, new Map());
    expect(reads).toHaveLength(MAX_SAMPLED_POINT_LISTS);
    expect(reads.every((r) => r.maxBytes === POINT_LIST_PREFIX_BYTES)).toBe(true);
    expect(reads[reads.length - 1].id).toBeGreaterThan(1000 + MAX_SAMPLED_POINT_LISTS * 2);
  });
});

describe('the two point-list types are sampled separately (review)', () => {
  it(`${MAX_SAMPLED_POINT_LISTS} 3D lists and one 2D list: the 2D list is still read`, () => {
    const ids3d = Array.from({ length: MAX_SAMPLED_POINT_LISTS }, (_, i) => 1000 + i);
    const reads: number[] = [];
    const reader: EntityReader = {
      get: () => undefined,
      idsOfType: (type) => (type === 'IFCCARTESIANPOINTLIST3D' ? ids3d : type === 'IFCCARTESIANPOINTLIST2D' ? [5000] : []),
      recordPrefix(id) {
        reads.push(id);
        return id === 5000 ? '#5000=IFCCARTESIANPOINTLIST2D(((2600000.,1200000.)),$);' : `#${id}=IFCCARTESIANPOINTLIST3D(((1.,2.,0.)),$);`;
      },
    };
    const { pointLists } = samplePointFamilies(reader, 2048, new Map());
    expect(reads).toContain(5000);
    expect(reads.length).toBeLessThanOrEqual(MAX_SAMPLED_POINT_LISTS);
    expect(pointLists.some((p) => p.x === 2_600_000)).toBe(true);
  });
});

describe('tuplesFromRecordPrefix', () => {
  it('keeps the complete tuples and drops the one the prefix cut', () => {
    expect(tuplesFromRecordPrefix('#5=IFCCARTESIANPOINTLIST3D(((1.,2.,3.),(4.5E3,-6.,7.),(8.,9')).toEqual([
      { x: 1, y: 2, z: 3 },
      { x: 4500, y: -6, z: 7 },
    ]);
  });
  it('reads a record with whitespace between its parentheses (STEP allows it)', () => {
    expect(tuplesFromRecordPrefix('#5=IFCCARTESIANPOINTLIST3D( ( (2600000.,1200000.,0.) ) , $);')).toEqual([{ x: 2_600_000, y: 1_200_000, z: 0 }]);
  });
  it('reads 2D lists with z = 0, and ignores a tag list', () => {
    expect(tuplesFromRecordPrefix("#5=IFCCARTESIANPOINTLIST2D(((1.,2.),(3.,4.)),('a','b'));")).toEqual([
      { x: 1, y: 2, z: 0 },
      { x: 3, y: 4, z: 0 },
    ]);
  });
});

describe('placement Locations that alternate with geometry points (review)', () => {
  it('8,192 points, every other one a placement Location: the geometry points are still sampled', () => {
    const ids = Array.from({ length: 8192 }, (_, i) => i + 1);
    const locations = new Map(ids.filter((id) => id % 2 === 1).map((id) => [id, 1] as const));
    const reader: EntityReader = {
      get: (id) => ({ type: 'IFCCARTESIANPOINT', attributes: [[id % 2 === 1 ? 1 : 2_600_000, id % 2 === 1 ? 2 : 1_200_000, 0]] }),
      idsOfType: (type) => (type === 'IFCCARTESIANPOINT' ? ids : []),
    };
    const { cartesianPoints } = samplePointFamilies(reader, 2048, locations);
    expect(cartesianPoints.length).toBeGreaterThan(0);
    expect(cartesianPoints.every((p) => p.x === 2_600_000)).toBe(true);
  });
});

describe('placement Locations are not geometry', () => {
  it('a far axis-placement Location does not make the geometry far', () => {
    const entities: Record<number, { type: string; attributes: unknown[] }> = {
      1: { type: 'IFCCARTESIANPOINT', attributes: [[2_600_000, 1_200_000, 0]] },
      2: { type: 'IFCAXIS2PLACEMENT3D', attributes: [1, null, null] },
      3: { type: 'IFCCARTESIANPOINT', attributes: [[1, 2, 0]] },
    };
    const reader: EntityReader = {
      get: (id) => entities[id],
      idsOfType: (type) => Object.keys(entities).map(Number).filter((id) => entities[id].type === type),
    };
    expect(samplePointFamilies(reader).cartesianPoints).toEqual([{ x: 1, y: 2, z: 0 }]);
  });
});

describe('firstReferenceIn', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  it('reads the reference right after the opening parenthesis', () => {
    expect(firstReferenceIn(bytes('#12=IFCAXIS2PLACEMENT3D(#11,#9,$);'))).toBe(11);
    expect(firstReferenceIn(bytes('#12= IFCAXIS2PLACEMENT3D( #1234567 ,$,$);'))).toBe(1234567);
  });
  it('is undefined for a non-reference first attribute or a reference cut by the window', () => {
    expect(firstReferenceIn(bytes('#12=IFCAXIS2PLACEMENT3D($,$,$);'))).toBeUndefined();
    expect(firstReferenceIn(bytes('#12=IFCAXIS2PLACEMENT3D(#11'))).toBeUndefined();
  });
});
